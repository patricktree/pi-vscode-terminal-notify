import * as vscode from "vscode";
import notifier from "node-notifier";
import {
  assertDarwin,
  formatError,
  getSocketDirectory,
  isRecord,
  listSocketPaths,
  type SocketLocateResponsePayload,
  type SocketRequestPayload,
  type SocketResponsePayload,
} from "@patricktree/pi-vscode-terminal-notify.shared";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const SOCKET_PREFIX = "pi-vscode-terminal-notify-";
const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_MESSAGE = "Pi is waiting for input";
const VSCODE_APP_NAME = "Visual Studio Code";

let activeTerminalProcessId: number | undefined;
let windowFocused = vscode.window.state.focused;
let server: net.Server | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext) {
  assertDarwin();
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
          await showNotificationForAncestors(socketPayload.ancestorPids);
          socket.end();
          break;
        }
        case "locate": {
          log("Handling locate command", { ancestorPids: socketPayload.ancestorPids });
          const terminal = await findTerminalForAncestors(socketPayload.ancestorPids);
          const response: SocketLocateResponsePayload = {
            ownsTerminal: Boolean(terminal),
            workspacePath: terminal ? getWorkspaceLaunchPath() : null,
          };
          log("Responding to locate request", response);
          socket.write(`${JSON.stringify(response)}\n`);
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

async function showNotificationForAncestors(ancestorPids: number[]) {
  const terminal = await findTerminalForAncestors(ancestorPids);
  const workspacePath = terminal
    ? getWorkspaceLaunchPath()
    : await resolveOwningWorkspacePath(ancestorPids);
  const workspaceTitle = workspacePath ? path.basename(workspacePath) : NOTIFICATION_TITLE;
  const workspaceLine = `Workspace: ${workspacePath ?? "Unknown"}`;
  const terminalLine = `Terminal: ${terminal?.name ?? "Unknown"}`;
  const message = `${NOTIFICATION_MESSAGE}\n${workspaceLine}\n${terminalLine}`;

  log("Showing MacOS notification", { ancestorPids, workspacePath, terminalName: terminal?.name });
  notifier.notify(
    {
      title: workspaceTitle,
      message,
      wait: true,
      timeout: 60,
    },
    (error: Error | null, response?: string, metadata?: unknown) => {
      if (error) {
        log("MacOS notification failed", { error: formatError(error) });
        return;
      }

      if (
        response === "activate" ||
        (isNotificationMetadata(metadata) && metadata.activationType === "contentsClicked")
      ) {
        void handleFocusTerminalAction(ancestorPids);
      }
    },
  );
}

async function handleFocusTerminalAction(ancestorPids: number[]) {
  log("Focus Terminal action selected", { ancestorPids });
  const localTerminal = await findTerminalForAncestors(ancestorPids);
  if (localTerminal) {
    const localWorkspacePath = getWorkspaceLaunchPath();
    if (localWorkspacePath) {
      await bringWindowToForeground(localWorkspacePath);
    } else {
      log("No workspace path resolved for local window");
    }
    await focusTerminalPanel(localTerminal);
    return;
  }

  const workspacePath = await resolveOwningWorkspacePath(ancestorPids);
  if (!workspacePath) {
    log("Unable to resolve owning window workspace path", { ancestorPids });
    return;
  }

  await bringWindowToForeground(workspacePath);
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

async function resolveOwningWorkspacePath(ancestorPids: number[]) {
  const socketPaths = await listSocketPaths(log);
  if (socketPaths.length === 0) {
    log("No socket paths available to resolve owning window");
    return undefined;
  }

  const results = await Promise.allSettled(
    socketPaths.map((socketPath) => locateSocket(socketPath, ancestorPids)),
  );

  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }

    if (result.value.ownsTerminal && result.value.workspacePath) {
      log("Resolved owning window", {
        socketPath: result.value.socketPath,
        workspacePath: result.value.workspacePath,
      });
      return result.value.workspacePath;
    }
  }

  log("No owning window resolved from socket scan", { ancestorPids });
  return undefined;
}

async function locateSocket(socketPath: string, ancestorPids: number[]) {
  return new Promise<SocketLocateResponsePayload & { socketPath: string }>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";

    socket.on("connect", () => {
      log("Sending locate command", { socketPath });
      socket.write(
        `${JSON.stringify({ command: "locate", ancestorPids } satisfies SocketRequestPayload)}\n`,
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        log("Waiting for complete locate response", { socketPath });
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      let payload: unknown;
      try {
        payload = JSON.parse(line) as unknown;
      } catch (error) {
        log("Failed to parse locate response", { socketPath, error: formatError(error) });
        socket.end();
        const parseError = error instanceof Error ? error : new Error(formatError(error));
        reject(parseError);
        return;
      }

      if (isSocketLocateResponsePayload(payload)) {
        resolve({ ...payload, socketPath });
      } else {
        log("Unexpected locate payload", { socketPath, payload });
        reject(new Error("Unexpected locate payload"));
      }

      socket.end();
    });

    socket.on("error", (error) => {
      log("Locate socket error", { socketPath, error: formatError(error) });
      reject(error);
    });

    socket.setTimeout(1000, () => {
      log("Locate socket timed out", { socketPath });
      socket.destroy();
      reject(new Error("Locate socket timed out"));
    });
  });
}

function getWorkspaceLaunchPath() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return workspaceFolder.uri.fsPath;
  }

  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile) {
    return path.dirname(workspaceFile.fsPath);
  }

  return null;
}

async function bringWindowToForeground(workspacePath: string) {
  log("Bringing VS Code window to foreground", { workspacePath });
  try {
    await execFileAsync("open", ["-a", VSCODE_APP_NAME, workspacePath]);
  } catch (error) {
    log("Failed to bring VS Code window to foreground", { error: formatError(error) });
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

function isNotificationMetadata(value: unknown): value is { activationType?: string } {
  if (!isRecord(value)) {
    return false;
  }

  const activationType = value["activationType"];
  return typeof activationType === "string";
}

function isSocketRequestPayload(value: Record<string, unknown>): value is SocketRequestPayload {
  const command = value["command"];
  const ancestorPids = value["ancestorPids"];
  return (
    (command === "query" || command === "notify" || command === "locate") &&
    Array.isArray(ancestorPids) &&
    ancestorPids.every((pid) => typeof pid === "number" && Number.isFinite(pid))
  );
}

function isSocketLocateResponsePayload(value: unknown): value is SocketLocateResponsePayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const ownsTerminal = record["ownsTerminal"];
  const workspacePath = record["workspacePath"];
  return (
    typeof ownsTerminal === "boolean" &&
    (typeof workspacePath === "string" || workspacePath === null)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function getSocketPath() {
  const socketPath = path.join(getSocketDirectory(), `${SOCKET_PREFIX}${process.pid}.sock`);
  log("Computed socket path", { socketPath });
  return socketPath;
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
