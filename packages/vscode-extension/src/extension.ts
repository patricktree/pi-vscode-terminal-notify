import * as vscode from "vscode";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCKET_DIRECTORY = path.join(".pi", "vscode-pi");
const SOCKET_PREFIX = "vscode-pi-";

let activeTerminalProcessId: number | undefined;
let focused = vscode.window.state.focused;
let server: net.Server | undefined;
let outputChannel: vscode.OutputChannel | undefined;

type SocketPayloadResult = {
  ancestorPids: number[];
  command: string;
};

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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseSocketPayload(line: string): SocketPayloadResult {
  let ancestorPids: number[] = [];
  let command = "query";

  try {
    const payload = JSON.parse(line) as unknown;
    if (isRecord(payload)) {
      if (Array.isArray(payload.ancestorPids)) {
        ancestorPids = payload.ancestorPids.filter(
          (pid): pid is number => typeof pid === "number" && Number.isFinite(pid),
        );
      }
      if (typeof payload.command === "string") {
        command = payload.command;
      }
    }
    log("Received socket payload", { command, ancestorPids });
  } catch (error) {
    log("Failed to parse socket payload", { error: formatError(error) });
  }

  return { ancestorPids, command };
}

function parseAncestorPidsFromUri(uri: vscode.Uri) {
  const params = new URLSearchParams(uri.query);
  const raw = params.get("ancestors");
  log("Parsing ancestor PIDs from URI", { raw });
  if (!raw) {
    return [];
  }

  const parsed = raw
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value));
  log("Parsed ancestor PIDs", { parsed });
  return parsed;
}

function isSilentUri(uri: vscode.Uri) {
  const params = new URLSearchParams(uri.query);
  const silent = params.get("silent") === "1";
  log("Parsed silent flag from URI", { silent });
  return silent;
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

async function listSocketPaths() {
  const socketDirectory = path.join(os.homedir(), SOCKET_DIRECTORY);
  log("Listing socket paths", { socketDirectory });
  try {
    const entries = await fs.promises.readdir(socketDirectory);
    const paths = entries
      .filter((entry) => entry.startsWith(SOCKET_PREFIX) && entry.endsWith(".sock"))
      .map((entry) => path.join(socketDirectory, entry));
    log("Listed socket paths", { count: paths.length, paths });
    return paths;
  } catch (error) {
    log("Failed to list socket paths", { error: formatError(error) });
    return [];
  }
}

async function broadcastFocusToSockets(ancestorPids: number[]) {
  const socketPaths = await listSocketPaths();
  log("Broadcasting focus to sockets", {
    count: socketPaths.length,
    ancestorPids,
  });

  await Promise.all(
    socketPaths.map(
      (socketPath) =>
        new Promise<void>((resolve) => {
          const socket = net.createConnection({ path: socketPath });
          socket.on("connect", () => {
            log("Sending focus command", { socketPath });
            socket.write(`${JSON.stringify({ command: "focus", ancestorPids })}\n`);
            socket.end();
          });
          socket.on("error", (error) => {
            log("Socket focus broadcast error", {
              socketPath,
              error: formatError(error),
            });
            resolve();
          });
          socket.on("close", () => {
            log("Focus broadcast socket closed", { socketPath });
            resolve();
          });
        }),
    ),
  );
  log("Finished broadcasting focus to sockets", {
    count: socketPaths.length,
  });
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

      const { ancestorPids, command } = parseSocketPayload(line);

      if (command === "focus") {
        log("Handling focus command", { ancestorPids });
        const terminal = await findTerminalForAncestors(ancestorPids);
        if (terminal) {
          try {
            await vscode.commands.executeCommand("workbench.action.focusWindow");
            log("Focused VS Code window");
          } catch (error) {
            log("Failed to focus VS Code window", { error: formatError(error) });
          }

          try {
            terminal.show(true);
            await vscode.commands.executeCommand("workbench.action.terminal.focus");
            log("Focused terminal panel");
          } catch (error) {
            log("Failed to focus terminal panel", { error: formatError(error) });
          }
        } else {
          log("No terminal matched focus request", { ancestorPids });
        }
      }

      const piTerminalActive =
        typeof activeTerminalProcessId === "number" &&
        ancestorPids.includes(activeTerminalProcessId);

      const response = {
        focused,
        piTerminalActive,
      };

      log("Responding to socket query", response);
      socket.write(`${JSON.stringify(response)}\n`);
      socket.end();
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

async function handleUriActivation(uri: vscode.Uri) {
  const silent = isSilentUri(uri);
  const ancestorPids = parseAncestorPidsFromUri(uri);
  log("Received URI activation", {
    uri: uri.toString(),
    ancestorPids,
    silent,
  });
  if (ancestorPids.length === 0) {
    if (!silent) {
      void vscode.window.showWarningMessage("Pi notification did not include ancestor PIDs.");
    }
    return;
  }

  await broadcastFocusToSockets(ancestorPids);
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Pi Terminal Notify");
  log("Output channel initialized");
  log("Extension activating");

  await updateActiveTerminalProcessId();

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      focused = state.focused;
      log("Window focus state changed", { focused });
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
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        void handleUriActivation(uri);
      },
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
