import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

const SOCKET_DIRECTORY = path.join(".pi", "vscode-pi");
const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_MESSAGE = "Pi is waiting for input";
const MAX_ANCESTOR_DEPTH = 15;
const TERMINAL_NOTIFIER_COMMAND = "terminal-notifier";
const FOCUS_SCRIPT_NAME = "focus-terminal.js";
const EXTENSION_LOG_PATH = path.join(
  os.homedir(),
  ".pi",
  "vscode-pi",
  "extension-log.txt",
);

let terminalNotifierAvailable: boolean | undefined;

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  const line = `[Pi Notify] ${timestamp} ${message}${suffix}\n`;

  try {
    fs.mkdirSync(path.dirname(EXTENSION_LOG_PATH), { recursive: true });
    fs.appendFileSync(EXTENSION_LOG_PATH, line, "utf8");
  } catch (error) {
    console.log(line.trimEnd(), { error: String(error) });
  }
}

function getSocketDirectory() {
  return path.join(os.homedir(), SOCKET_DIRECTORY);
}

function getFocusScriptPath() {
  return path.join(getSocketDirectory(), FOCUS_SCRIPT_NAME);
}

function execFileAsync(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getParentPid(pid: number) {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "ppid=",
      "-p",
      String(pid),
    ]);
    const parsed = parseInt(stdout.trim(), 10);
    const parent = Number.isNaN(parsed) ? undefined : parsed;
    log("Fetched parent PID", { pid, parent });
    return parent;
  } catch (error) {
    log("Failed to fetch parent PID", { pid, error: String(error) });
    return undefined;
  }
}

async function isTerminalNotifierAvailable() {
  if (terminalNotifierAvailable !== undefined) {
    return terminalNotifierAvailable;
  }

  try {
    await execFileAsync("which", [TERMINAL_NOTIFIER_COMMAND]);
    terminalNotifierAvailable = true;
  } catch (error) {
    terminalNotifierAvailable = false;
  }

  log("Terminal notifier availability", {
    available: terminalNotifierAvailable,
  });
  return terminalNotifierAvailable;
}

async function getAncestorPids(maxDepth = MAX_ANCESTOR_DEPTH) {
  const ancestors: number[] = [];
  let currentPid = process.pid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    ancestors.push(currentPid);
    if (currentPid === 1) break;

    const parentPid = await getParentPid(currentPid);
    if (!parentPid || parentPid === currentPid) break;

    currentPid = parentPid;
  }

  log("Collected ancestor PIDs", { ancestors });
  return ancestors;
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
    log("Failed to list socket paths", { error: String(error) });
    return [];
  }
}

async function querySocket(socketPath: string, ancestorPids: number[]) {
  return new Promise<
    { focused: boolean; piTerminalActive: boolean } | undefined
  >((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";

    socket.on("connect", () => {
      log("Connected to socket", { socketPath });
      socket.write(`${JSON.stringify({ command: "query", ancestorPids })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      try {
        const payload = JSON.parse(line);
        if (
          typeof payload?.focused === "boolean" &&
          typeof payload?.piTerminalActive === "boolean"
        ) {
          log("Received socket response", { socketPath, payload });
          resolve({
            focused: payload.focused,
            piTerminalActive: payload.piTerminalActive,
          });
        } else {
          log("Unexpected socket payload", { socketPath, payload });
          resolve(undefined);
        }
      } catch (error) {
        log("Failed to parse socket response", {
          socketPath,
          error: String(error),
        });
        resolve(undefined);
      }

      socket.end();
    });

    socket.on("error", (error) => {
      log("Socket connection error", { socketPath, error: String(error) });
      resolve(undefined);
    });

    socket.setTimeout(1000, () => {
      log("Socket query timed out", { socketPath });
      socket.destroy();
      resolve(undefined);
    });
  });
}

async function isPiTerminalFocused(ancestorPids: number[]) {
  const socketPaths = await listSocketPaths();
  for (const socketPath of socketPaths) {
    const response = await querySocket(socketPath, ancestorPids);
    if (response?.focused && response?.piTerminalActive) {
      log("Pi terminal is focused", { socketPath });
      return true;
    }
  }

  log("Pi terminal is not focused");
  return false;
}

async function ensureFocusScript() {
  const socketDirectory = getSocketDirectory();
  await fs.promises.mkdir(socketDirectory, { recursive: true });
  const scriptPath = getFocusScriptPath();

  const script = `const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const logPath = path.join(os.homedir(), ".pi", "vscode-pi", "focus-script-log.txt");
const dir = process.argv[2];
const ancestors = (process.argv[3] || "")
  .split(",")
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value));
const log = (message, data) => {
  const timestamp = new Date().toISOString();
  const suffix = data ? " " + JSON.stringify(data) : "";
  const line = "[Pi Focus Script] " + timestamp + " " + message + suffix + "\n";
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, "utf8");
  } catch (_) {
    // ignore logging failures
  }
};
if (!dir || ancestors.length === 0) {
  log("Missing directory or ancestors", { dir, ancestors });
  process.exit(0);
}
log("Starting focus script", { dir, ancestors });
fs.readdir(dir, (err, entries) => {
  if (err) {
    log("Failed to read directory", { dir, error: String(err) });
    return;
  }
  entries.filter((entry) => entry.endsWith(".sock")).forEach((entry) => {
    const socketPath = path.join(dir, entry);
    const socket = net.createConnection({ path: socketPath });
    socket.on("connect", () => {
      log("Connected to socket", { socketPath });
      socket.write(JSON.stringify({ command: "focus", ancestorPids: ancestors }) + "\\n");
      socket.end();
    });
    socket.on("error", (error) => {
      log("Socket error", { socketPath, error: String(error) });
    });
  });
});`;

  await fs.promises.writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function buildFocusCommand(ancestorPids: number[]) {
  const nodePath = process.execPath;
  const scriptPath = await ensureFocusScript();
  const socketDirectory = getSocketDirectory();
  const ancestors = ancestorPids.join(",");

  const quote = (value: string) => JSON.stringify(value);
  return `${quote(nodePath)} ${quote(scriptPath)} ${quote(socketDirectory)} ${quote(ancestors)}`;
}

async function sendNotification(ancestorPids: number[]) {
  if (!(await isTerminalNotifierAvailable())) {
    throw new Error("terminal-notifier is not available");
  }

  const socketPaths = await listSocketPaths();

  if (socketPaths.length > 0) {
    const focusCommand = await buildFocusCommand(ancestorPids);
    return execFileAsync(TERMINAL_NOTIFIER_COMMAND, [
      "-title",
      NOTIFICATION_TITLE,
      "-message",
      NOTIFICATION_MESSAGE,
      "-execute",
      focusCommand,
      "-activate",
      "com.microsoft.VSCode",
      "-group",
      `pi-${process.pid}`,
    ]);
  }
}

export default function registerVscodeSocketNotify(pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    const ancestorPids = await getAncestorPids();
    const piTerminalFocused = await isPiTerminalFocused(ancestorPids);

    if (!piTerminalFocused) {
      await sendNotification(ancestorPids);
    }
  });
}
