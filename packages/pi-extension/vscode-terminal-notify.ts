import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

const SOCKET_DIRECTORY = path.join(".pi", "vscode-terminal-notification");
const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_MESSAGE = "Pi is waiting for input";
const MAX_ANCESTOR_DEPTH = 15;
const TERMINAL_NOTIFIER_COMMAND = "terminal-notifier";
const FOCUS_SCRIPT_NAME = "focus-terminal.mjs";
const EXTENSION_LOG_PATH = path.join(
  os.homedir(),
  ".pi",
  "vscode-terminal-notification",
  "pi-extension-log.txt",
);

let terminalNotifierAvailablePromise: Promise<boolean> | undefined;

type SocketPayload = {
  focused: boolean;
  piTerminalActive: boolean;
};

export default function registerVscodeSocketNotify(pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    const ancestorPids = await getAncestorPids();
    const piTerminalFocused = await isPiTerminalFocused(ancestorPids);

    if (!piTerminalFocused) {
      await sendNotification(ancestorPids);
    }
  });
}

async function getAncestorPids(maxDepth = MAX_ANCESTOR_DEPTH) {
  const ancestors: number[] = [];
  let currentPid = process.pid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    ancestors.push(currentPid);
    if (currentPid === 1) {
      break;
    }

    const parentPid = await getParentPid(currentPid);
    if (!parentPid || parentPid === currentPid) {
      break;
    }

    currentPid = parentPid;
  }

  log("Collected ancestor PIDs", { ancestors });
  return ancestors;
}

async function isPiTerminalFocused(ancestorPids: number[]) {
  const socketPaths = await listSocketPaths();
  const responses = await Promise.all(
    socketPaths.map((socketPath) => querySocket(socketPath, ancestorPids)),
  );
  const piTerminalFocused = responses.some(
    (response) => response && response.focused && response.piTerminalActive,
  );

  if (piTerminalFocused) {
    log("Pi terminal is focused");
    return true;
  }

  log("Pi terminal is not focused");
  return false;
}

async function sendNotification(ancestorPids: number[]) {
  if (!(await isTerminalNotifierAvailable())) {
    throw new Error("terminal-notifier is not available");
  }

  const socketPaths = await listSocketPaths();

  log("Preparing to send notification", { socketCount: socketPaths.length });

  if (socketPaths.length === 0) {
    log("No Pi terminal sockets found, skipping notification");
    return;
  }

  log("Sending notification with focus command");
  const focusCommand = await buildFocusCommand(ancestorPids);
  log("Focus command built", { focusCommand });
  await execFileAsync(TERMINAL_NOTIFIER_COMMAND, [
    "-title",
    NOTIFICATION_TITLE,
    "-message",
    NOTIFICATION_MESSAGE,
    "-execute",
    focusCommand,
    "-group",
    `pi-${process.pid}`,
  ]);
  log("Notification sent");
}

async function buildFocusCommand(ancestorPids: number[]) {
  const nodePath = process.execPath;
  const scriptPath = await ensureFocusScript();
  const socketDirectory = getSocketDirectory();
  const ancestors = ancestorPids.join(",");

  return `${quoteCommandPart(nodePath)} ${quoteCommandPart(scriptPath)} ${quoteCommandPart(
    socketDirectory,
  )} ${quoteCommandPart(ancestors)}`;
}

async function ensureFocusScript() {
  const socketDirectory = getSocketDirectory();
  await fs.promises.mkdir(socketDirectory, { recursive: true });
  const scriptPath = getFocusScriptPath();
  const scriptSourceUrl = new URL("focus-terminal.mjs", import.meta.url);
  const script = await fs.promises.readFile(scriptSourceUrl, "utf8");
  await fs.promises.writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function listSocketPaths() {
  const socketDirectory = getSocketDirectory();
  try {
    const entries = await fs.promises.readdir(socketDirectory);
    const paths = entries
      .filter((entry) => entry.endsWith(".sock"))
      .map((entry) => path.join(socketDirectory, entry));
    log("Listed socket paths", { count: paths.length, paths });
    return paths;
  } catch (error) {
    log("Failed to list socket paths", { error: formatError(error) });
    return [];
  }
}

async function querySocket(socketPath: string, ancestorPids: number[]) {
  return new Promise<{ focused: boolean; piTerminalActive: boolean } | undefined>((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";

    socket.on("connect", () => {
      log("Connected to socket", { socketPath });
      socket.write(`${JSON.stringify({ command: "query", ancestorPids })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      let payload: unknown;
      try {
        payload = JSON.parse(line) as unknown;
      } catch (error) {
        log("Failed to parse socket response", {
          socketPath,
          error: formatError(error),
        });
        socket.end();
        resolve(undefined);
        return;
      }

      if (isSocketPayload(payload)) {
        log("Received socket response", { socketPath, payload });
        resolve({
          focused: payload.focused,
          piTerminalActive: payload.piTerminalActive,
        });
      } else {
        log("Unexpected socket payload", { socketPath, payload });
        resolve(undefined);
      }

      socket.end();
    });

    socket.on("error", (error) => {
      log("Socket connection error", { socketPath, error: formatError(error) });
      resolve(undefined);
    });

    socket.setTimeout(1000, () => {
      log("Socket query timed out", { socketPath });
      socket.destroy();
      resolve(undefined);
    });
  });
}

async function isTerminalNotifierAvailable() {
  if (!terminalNotifierAvailablePromise) {
    terminalNotifierAvailablePromise = (async () => {
      try {
        await execFileAsync("which", [TERMINAL_NOTIFIER_COMMAND]);
        return true;
      } catch {
        return false;
      }
    })();
  }

  const available = await terminalNotifierAvailablePromise;
  log("Terminal notifier availability", {
    available,
  });
  return available;
}

async function getParentPid(pid: number) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    const parent = Number.isNaN(parsed) ? undefined : parsed;
    log("Fetched parent PID", { pid, parent });
    return parent;
  } catch (error) {
    log("Failed to fetch parent PID", { pid, error: formatError(error) });
    return undefined;
  }
}

function getSocketDirectory() {
  return path.join(os.homedir(), SOCKET_DIRECTORY);
}

function getFocusScriptPath() {
  return path.join(getSocketDirectory(), FOCUS_SCRIPT_NAME);
}

function quoteCommandPart(value: string) {
  return JSON.stringify(value);
}

function execFileAsync(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        const execError = error instanceof Error ? error : new Error(formatError(error));
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isSocketPayload(value: unknown): value is SocketPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record["focused"] === "boolean" && typeof record["piTerminalActive"] === "boolean";
}

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  const line = `[Pi Notify] ${timestamp} ${message}${suffix}\n`;

  void (async () => {
    try {
      await fs.promises.mkdir(path.dirname(EXTENSION_LOG_PATH), {
        recursive: true,
      });
      await fs.promises.appendFile(EXTENSION_LOG_PATH, line, "utf8");
    } catch (error) {
      const errorSuffix = JSON.stringify({ error: formatError(error) });
      process.stderr.write(`${line.trimEnd()} ${errorSuffix}\n`);
    }
  })();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}
