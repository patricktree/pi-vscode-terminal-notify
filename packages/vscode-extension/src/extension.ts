import * as vscode from "vscode";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCKET_RELATIVE_PATH = path.join(".pi", "vscode-pi.sock");

let activeTerminalProcessId: number | undefined;
let focused = vscode.window.state.focused;
let server: net.Server | undefined;

async function updateActiveTerminalProcessId() {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal) {
    activeTerminalProcessId = undefined;
    return;
  }

  try {
    const pid = await activeTerminal.processId;
    activeTerminalProcessId = pid ?? undefined;
  } catch (error) {
    console.warn("Failed to read active terminal processId", error);
    activeTerminalProcessId = undefined;
  }
}

function getSocketPath() {
  return path.join(os.homedir(), SOCKET_RELATIVE_PATH);
}

function ensureSocketDirectory(socketPath: string) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true });
}

function removeStaleSocket(socketPath: string) {
  if (!fs.existsSync(socketPath)) return;

  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    console.warn("Failed to remove stale socket", error);
  }
}

function startServer() {
  const socketPath = getSocketPath();
  ensureSocketDirectory(socketPath);
  removeStaleSocket(socketPath);

  server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      let ancestorPids: number[] = [];
      try {
        const payload = JSON.parse(line);
        if (Array.isArray(payload?.ancestorPids)) {
          ancestorPids = payload.ancestorPids.filter((pid: unknown) => typeof pid === "number");
        }
      } catch (error) {
        console.warn("Failed to parse socket payload", error);
      }

      const piTerminalActive =
        typeof activeTerminalProcessId === "number" && ancestorPids.includes(activeTerminalProcessId);

      const response = {
        focused,
        piTerminalActive,
      };

      socket.write(`${JSON.stringify(response)}\n`);
      socket.end();
    });

    socket.on("error", (error) => {
      console.warn("Socket error", error);
    });
  });

  server.on("error", (error) => {
    console.error("VS Code socket server error", error);
  });

  server.listen(socketPath, () => {
    console.log(`Pi socket server listening on ${socketPath}`);
  });
}

export async function activate(context: vscode.ExtensionContext) {
  await updateActiveTerminalProcessId();

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      focused = state.focused;
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(() => {
      void updateActiveTerminalProcessId();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => {
      void updateActiveTerminalProcessId();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal(() => {
      void updateActiveTerminalProcessId();
    })
  );

  startServer();
}

export function deactivate() {
  if (server) {
    server.close();
    server = undefined;
  }

  const socketPath = getSocketPath();
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      console.warn("Failed to clean up socket", error);
    }
  }
}
