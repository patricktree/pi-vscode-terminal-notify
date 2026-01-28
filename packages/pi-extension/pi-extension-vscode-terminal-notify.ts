import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  assertDarwin,
  formatError,
  listSocketPaths,
  VscodeTerminalNotifySocketProtoSchema,
  type VscodeTerminalNotifySocketProto,
} from "@patricktree/pi-vscode-terminal-notify.shared";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

const MAX_ANCESTOR_DEPTH = 15;
const EXTENSION_LOG_PATH = path.join(
  os.homedir(),
  ".pi",
  "pi-vscode-terminal-notify",
  "pi-extension-log.txt",
);

export default function registerVscodeSocketNotify(pi: ExtensionAPI) {
  assertDarwin();
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
  const socketPaths = await listSocketPaths(log);
  const responses = await Promise.all(
    socketPaths.map((socketPath) => querySocket(socketPath, ancestorPids)),
  );
  const piTerminalFocused = responses.some(
    (response) => response.windowFocused && response.piTerminalActive,
  );

  if (piTerminalFocused) {
    log("Pi terminal is focused");
    return true;
  }

  log("Pi terminal is not focused");
  return false;
}

async function sendNotification(ancestorPids: number[]) {
  const socketPaths = await listSocketPaths(log);

  log("Preparing to send notification", { socketCount: socketPaths.length });

  if (socketPaths.length === 0) {
    log("No Pi terminal sockets found, skipping notification");
    return;
  }

  log("Sending VS Code notification command");
  await Promise.all(socketPaths.map((socketPath) => notifySocket(socketPath, ancestorPids)));
  log("Notification command sent");
}

async function querySocket(socketPath: string, ancestorPids: number[]) {
  return new Promise<VscodeTerminalNotifySocketProto["query"]["response"]>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";

    socket.on("connect", () => {
      log("Connected to socket", { socketPath });
      socket.write(
        `${JSON.stringify({ command: "query", ancestorPids } satisfies VscodeTerminalNotifySocketProto["query"]["request"])}\n`,
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        throw new Error("Incomplete socket response");
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
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
        return;
      }

      try {
        const parsedPayload =
          VscodeTerminalNotifySocketProtoSchema.shape.query.shape.response.parse(payload);
        resolve(parsedPayload);
      } catch {
        log("Unexpected socket payload", { socketPath, payload });
        reject(new Error("Unexpected socket payload"));
      }

      socket.end();
    });

    socket.on("error", (error) => {
      log("Socket connection error", { socketPath, error: formatError(error) });
      reject(new Error(formatError(error)));
    });

    socket.setTimeout(1000, () => {
      log("Socket query timed out", { socketPath });
      socket.destroy();
      reject(new Error("Socket query timed out"));
    });
  });
}

async function notifySocket(socketPath: string, ancestorPids: number[]) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });

    socket.on("connect", () => {
      log("Sending notify command", { socketPath });
      socket.write(
        `${JSON.stringify({ command: "notify", ancestorPids } satisfies VscodeTerminalNotifySocketProto["notify"]["request"])}\n`,
      );
      socket.end();
    });

    socket.on("error", (error) => {
      log("Notify socket error", { socketPath, error: formatError(error) });
      reject(error);
    });

    socket.on("close", () => {
      resolve();
    });
  });
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
