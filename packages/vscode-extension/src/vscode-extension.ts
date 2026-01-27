import * as vscode from "vscode";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCKET_DIRECTORY = path.join(".pi", "vscode-terminal-notification");
const SOCKET_PREFIX = "vscode-terminal-notification-";
const NOTIFICATION_MESSAGE = "Pi is waiting for input";
const NOTIFICATION_ACTION = "Focus Terminal";

let activeTerminalProcessId: number | undefined;
let windowFocused = vscode.window.state.focused;
let server: net.Server | undefined;
let outputChannel: vscode.OutputChannel | undefined;

type SocketRequestPayload =
  | {
      command: "query";
      ancestorPids: number[];
    }
  | {
      command: "notify";
      ancestorPids: number[];
    };

type SocketResponsePayload = {
  windowFocused: boolean;
  piTerminalActive: boolean;
};

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Pi Terminal Notify");
  log("Output channel initialized");
  log("Extension activating");

  await updateActiveTerminalProcessId();

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
      log("Window focus state changed", { windowFocused });
    }),
    vscode.window.onDidChangeActiveTerminal(() => {
      log("Active terminal changed");
      void updateActiveTerminalProcessId();
    }),
    vscode.window.onDidOpenTerminal(() => {
      log("Terminal opened");
      void updateActiveTerminalProcessId();
    }),
    vscode.window.onDidCloseTerminal(() => {
      log("Terminal closed");
      void updateActiveTerminalProcessId();
    }),
  );

  await startServer();
  log("Extension activated");
}

export async function deactivate() {
  log("Extension deactivating");
  if (server) {
    server.close();
    server = undefined;
    log("Socket server closed");
  }

  const socketPath = getSocketPath();
  try {
    await fs.promises.unlink(socketPath);
    log("Removed socket file", { socketPath });
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      log("Failed to clean up socket", { error: formatError(error) });
    }
  }

  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
    log("Output channel disposed");
  }
}

async function startServer() {
  log("Starting Pi socket server");
  const socketPath = getSocketPath();
  await ensureSocketDirectory(socketPath);
  await removeStaleSocket(socketPath);

  server = net.createServer((socket) => {
    let buffer = "";
    log("Socket client connected");

    const handleSocketData = async (chunk: Buffer) => {
      log("Socket data received", { bytes: chunk.length });
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        log("Waiting for complete socket payload", {
          bufferedBytes: buffer.length,
        });
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      const socketPayload = parseSocketPayload(line);

      switch (socketPayload.command) {
        case "query": {
          const piTerminalActive =
            typeof activeTerminalProcessId === "number" &&
            socketPayload.ancestorPids.includes(activeTerminalProcessId);
          const response: SocketResponsePayload = {
            windowFocused,
            piTerminalActive,
          };

          log("Responding to socket query", response);
          socket.write(`${JSON.stringify(response)}\n`);
          socket.end();
          break;
        }
        case "notify": {
          log("Handling notify command", { ancestorPids: socketPayload.ancestorPids });
          const terminal = await findTerminalForAncestors(socketPayload.ancestorPids);
          if (terminal) {
            await showNotificationForTerminal(terminal);
          } else {
            log("No terminal matched notify request", { ancestorPids: socketPayload.ancestorPids });
          }
          socket.end();
          break;
        }
      }
    };

    socket.on("data", (chunk) => {
      void handleSocketData(chunk);
    });

    socket.on("error", (error) => {
      log("Socket error", { error: formatError(error) });
    });

    socket.on("close", () => {
      log("Socket client disconnected");
    });
  });

  server.on("error", (error) => {
    log("VS Code socket server error", { error: formatError(error) });
  });

  server.on("close", () => {
    log("Pi socket server stopped");
  });

  server.listen(socketPath, () => {
    log("Pi socket server listening", { socketPath });
  });
}

async function showNotificationForTerminal(terminal: vscode.Terminal) {
  log("Showing VS Code notification");
  const selection = await vscode.window.showInformationMessage(
    NOTIFICATION_MESSAGE,
    NOTIFICATION_ACTION,
  );

  if (selection === NOTIFICATION_ACTION) {
    await focusTerminalPanel(terminal);
  }
}

async function focusTerminalPanel(terminal: vscode.Terminal) {
  terminal.show(true);
  await vscode.commands.executeCommand("workbench.action.terminal.focus");
  log("Focused terminal panel");
}

async function findTerminalForAncestors(ancestorPids: number[]) {
  if (ancestorPids.length === 0) {
    log("No ancestor PIDs provided for terminal lookup");
    return undefined;
  }

  const activeTerminal = vscode.window.activeTerminal;
  log("Searching terminals for ancestor match", {
    ancestorPids,
    terminalCount: vscode.window.terminals.length,
    hasActiveTerminal: Boolean(activeTerminal),
  });
  if (activeTerminal && (await terminalMatchesAncestors(activeTerminal, ancestorPids))) {
    log("Active terminal matched ancestors");
    return activeTerminal;
  }

  for (const terminal of vscode.window.terminals) {
    if (terminal === activeTerminal) {
      continue;
    }
    if (await terminalMatchesAncestors(terminal, ancestorPids)) {
      log("Found matching terminal in list");
      return terminal;
    }
  }

  log("No terminal matched ancestor PIDs", { ancestorPids });
  return undefined;
}

async function terminalMatchesAncestors(terminal: vscode.Terminal, ancestorPids: number[]) {
  try {
    const pid = await terminal.processId;
    const matches = typeof pid === "number" && ancestorPids.includes(pid);
    log("Checked terminal processId", { pid, matches });
    return matches;
  } catch (error) {
    log("Failed to read terminal processId", { error: formatError(error) });
    return false;
  }
}

async function updateActiveTerminalProcessId() {
  const activeTerminal = vscode.window.activeTerminal;
  log("Refreshing active terminal processId", {
    hasActiveTerminal: Boolean(activeTerminal),
  });
  if (!activeTerminal) {
    activeTerminalProcessId = undefined;
    log("Active terminal cleared (none present)");
    return;
  }

  try {
    const pid = await activeTerminal.processId;
    activeTerminalProcessId = pid ?? undefined;
    log("Updated active terminal processId", { pid: activeTerminalProcessId });
  } catch (error) {
    log("Failed to read active terminal processId", { error: formatError(error) });
    activeTerminalProcessId = undefined;
  }
}

function parseSocketPayload(line: string): SocketRequestPayload {
  try {
    const payload = JSON.parse(line) as unknown;
    if (isRecord(payload) && isSocketRequestPayload(payload)) {
      log("Received socket payload", {
        command: payload.command,
        ancestorPids: payload.ancestorPids,
      });
      return payload;
    } else {
      log("Socket payload is not a valid SocketRequestPayload", { payload });
      throw new Error("Invalid socket payload");
    }
  } catch (error) {
    log("Failed to parse socket payload", { error: formatError(error) });
    throw error;
  }
}

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  const line = `[Pi Notify] ${timestamp} ${message}${suffix}`;
  if (outputChannel) {
    outputChannel.appendLine(line);
  }
  console.log(line);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSocketRequestPayload(value: Record<string, unknown>): value is SocketRequestPayload {
  const command = value["command"];
  const ancestorPids = value["ancestorPids"];
  return (
    (command === "query" || command === "notify") &&
    Array.isArray(ancestorPids) &&
    ancestorPids.every((pid) => typeof pid === "number" && Number.isFinite(pid))
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getSocketPath() {
  const socketPath = path.join(
    os.homedir(),
    SOCKET_DIRECTORY,
    `${SOCKET_PREFIX}${process.pid}.sock`,
  );
  log("Computed socket path", { socketPath });
  return socketPath;
}

async function ensureSocketDirectory(socketPath: string) {
  const dir = path.dirname(socketPath);
  log("Ensuring socket directory exists", { dir });
  await fs.promises.mkdir(dir, { recursive: true });
}

async function removeStaleSocket(socketPath: string) {
  try {
    await fs.promises.stat(socketPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      log("No stale socket to remove", { socketPath });
      return;
    }
    log("Failed to check stale socket", { error: formatError(error) });
    return;
  }

  try {
    await fs.promises.unlink(socketPath);
    log("Removed stale socket", { socketPath });
  } catch (error) {
    log("Failed to remove stale socket", { error: formatError(error) });
  }
}
