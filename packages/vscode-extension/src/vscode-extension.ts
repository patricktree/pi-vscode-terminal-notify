import * as vscode from "vscode";
import { notify, type NotificationResponse } from "./terminal-notifier.js";
import {
  assertDarwin,
  formatError,
  getSocketDirectory,
  listSocketPaths,
  VscodeTerminalNotifySocketProtoSchema,
  VscodeTerminalNotifySocketRequestSchema,
  type VscodeTerminalNotifySocketProto,
  type VscodeTerminalNotifySocketRequest,
} from "@patricktree/pi-vscode-terminal-notify.shared";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const SOCKET_PREFIX = "pi-vscode-terminal-notify-";
const NOTIFICATION_TITLE = "Pi is waiting for input";
const VSCODE_APP_NAME = "Visual Studio Code";
const VSCODE_BUNDLE_ID = "com.microsoft.VSCode";

let server: net.Server | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(_context: vscode.ExtensionContext) {
  assertDarwin();
  outputChannel = vscode.window.createOutputChannel("Pi Terminal Notify");
  log("Output channel initialized");
  log("Extension activating");

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
        case "maybeNotify": {
          log("Handling maybeNotify command", { ancestorPids: socketPayload.ancestorPids });
          await handleMaybeNotify(socketPayload.ancestorPids);
          socket.end();
          break;
        }
        case "locate": {
          log("Handling locate command", { ancestorPids: socketPayload.ancestorPids });
          const terminal = await findTerminalForAncestors(socketPayload.ancestorPids);
          const response: VscodeTerminalNotifySocketProto["locate"]["response"] = {
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

async function handleMaybeNotify(ancestorPids: number[]) {
  const terminal = await findTerminalForAncestors(ancestorPids);
  if (!terminal) {
    log("Skipping notification - terminal not owned by this window", { ancestorPids });
    return;
  }

  const terminalPid = await terminal.processId;
  if (!terminalPid) {
    log("Skipping notification - could not resolve terminal PID");
    return;
  }

  const windowFocused = vscode.window.state.focused;
  const activeTerminal = vscode.window.activeTerminal;
  const piTerminalActive = activeTerminal === terminal;

  log("Checking notification conditions", { windowFocused, piTerminalActive });

  if (windowFocused && piTerminalActive) {
    log("Skipping notification - Pi terminal is focused");
    return;
  }

  showNotification(ancestorPids, terminal, terminalPid);
}

function showNotification(ancestorPids: number[], terminal: vscode.Terminal, terminalPid: number) {
  const workspacePath = getWorkspaceLaunchPath();
  const workspaceLine = `Workspace: ${workspacePath ?? "Unknown"}`;
  const terminalLine = `Terminal: ${terminal.name}`;
  const message = `${terminalLine}\n${workspaceLine}`;

  log("Showing MacOS notification", {
    ancestorPids,
    workspacePath,
    terminalName: terminal.name,
    terminalPid,
  });

  notify(
    {
      title: NOTIFICATION_TITLE,
      message,
      activate: VSCODE_BUNDLE_ID,
      group: `pi-terminal-${terminalPid}`,
    },
    (error: Error | null, _response?: string, metadata?: NotificationResponse) => {
      if (error) {
        log("MacOS notification failed", { error: formatError(error) });
        return;
      }

      if (metadata?.activationType === "contentsClicked") {
        void handleFocusTerminalAction(ancestorPids);
      }
    },
    log,
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
  return new Promise<
    VscodeTerminalNotifySocketProto["locate"]["response"] & { socketPath: string }
  >((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";

    socket.on("connect", () => {
      log("Sending locate command", { socketPath });
      socket.write(
        `${JSON.stringify({ command: "locate", ancestorPids } satisfies VscodeTerminalNotifySocketProto["locate"]["request"])}\n`,
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
      let json: unknown;
      try {
        json = JSON.parse(line) as unknown;
      } catch (error) {
        log("Failed to parse locate response", { socketPath, error: formatError(error) });
        socket.end();
        const parseError = error instanceof Error ? error : new Error(formatError(error));
        reject(parseError);
        return;
      }

      try {
        const payload =
          VscodeTerminalNotifySocketProtoSchema.shape.locate.shape.response.parse(json);
        resolve({ ...payload, socketPath });
      } catch {
        log("Unexpected locate payload", { socketPath, payload: json });
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

function parseSocketPayload(line: string): VscodeTerminalNotifySocketRequest {
  try {
    const json = JSON.parse(line) as unknown;
    const payload = VscodeTerminalNotifySocketRequestSchema.parse(json);
    log("Received socket payload", {
      command: payload.command,
      ancestorPids: payload.ancestorPids,
    });
    return payload;
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
