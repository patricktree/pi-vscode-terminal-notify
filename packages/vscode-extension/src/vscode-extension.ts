import * as vscode from "vscode";
import {
  notify,
  removeNotification,
  type NotificationResponse,
} from "@patricktree/pi-vscode-terminal-notify.pi-terminal-notifier";
import {
  assertDarwin,
  formatError,
} from "@patricktree/pi-vscode-terminal-notify.shared";
import path from "node:path";
import { execFile } from "node:child_process";

const NOTIFICATION_TITLE = "Pi is waiting for input";
const VSCODE_APP_NAME = "Visual Studio Code";

let outputChannel: vscode.OutputChannel | undefined;

/** Tracks terminal PIDs with active (pending) notifications */
const activeNotificationPids = new Set<number>();
const terminalPidMap = new Map<vscode.Terminal, number>();

type ParsedNotification = { title?: string; body: string };

class OscParser {
  private buffer = "";
  private readonly onNotify: (n: ParsedNotification) => void;

  constructor(onNotify: (n: ParsedNotification) => void) {
    this.onNotify = onNotify;
  }

  public feed(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 256 * 1024) {
      this.buffer = this.buffer.slice(-128 * 1024);
    }

    this.unwrapTmuxPassthrough();

    const ESC = "\u001B";
    const BEL = "\u0007";
    const OSC_PREFIX = `${ESC  }]`;
    const ST = `${ESC  }\\`;

    while (true) {
      const start = this.buffer.indexOf(OSC_PREFIX);
      if (start === -1) {
        if (this.buffer.length > 4096) {
          this.buffer = this.buffer.slice(-4096);
        }
        return;
      }

      const afterStart = start + OSC_PREFIX.length;
      const endBel = this.buffer.indexOf(BEL, afterStart);
      const endSt = this.buffer.indexOf(ST, afterStart);

      let end = -1;
      let consume = 0;
      if (endBel !== -1 && (endSt === -1 || endBel < endSt)) {
        end = endBel;
        consume = 1;
      } else if (endSt !== -1) {
        end = endSt;
        consume = 2;
      } else {
        if (start > 0) {
          this.buffer = this.buffer.slice(start);
        }
        return;
      }

      const content = this.buffer.slice(afterStart, end);
      this.buffer = this.buffer.slice(end + consume);

      this.tryParseOsc(content);
    }
  }

  private tryParseOsc(content: string) {
    const s = content.trim();
    if (!s.startsWith("777;")) {
      return;
    }

    const parts = s.split(";");
    const command = parts[1];
    if (command?.toLowerCase() !== "notify") {
      return;
    }

    const title = parts[2] ?? "Terminal";
    const body = parts.length >= 4 ? parts.slice(3).join(";") : "";
    if (body.length > 0 || title.length > 0) {
      this.onNotify({ title, body });
    }
  }

  private unwrapTmuxPassthrough() {
    const ESC = "\u001B";
    const DCS_TMUX = `${ESC}Ptmux;`;
    const ST = `${ESC}\\`;

    while (true) {
      const i = this.buffer.indexOf(DCS_TMUX);
      if (i === -1) {
        return;
      }

      const after = i + DCS_TMUX.length;
      const end = this.buffer.indexOf(ST, after);
      if (end === -1) {
        if (i > 0) {
          this.buffer = this.buffer.slice(i);
        }
        return;
      }

      const inner = this.buffer
        .slice(after, end)
        .split("\u001B\u001B")
        .join("\u001B");
      this.buffer = this.buffer.slice(0, i) + inner + this.buffer.slice(end + ST.length);
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  assertDarwin();
  outputChannel = vscode.window.createOutputChannel("Pi Terminal Notify");
  log("Output channel initialized");
  log("Extension activating");

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      void handleShellExecution(event);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      cleanupTerminalState(terminal);
    }),
    vscode.window.onDidChangeActiveTerminal(() => {
      void clearNotificationIfTerminalFocused();
    }),
    vscode.window.onDidChangeWindowState(() => {
      void clearNotificationIfTerminalFocused();
    }),
  );

  log("Extension activated");
}

export function deactivate() {
  log("Extension deactivating");
  terminalPidMap.clear();

  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
    log("Output channel disposed");
  }
}

async function handleShellExecution(event: vscode.TerminalShellExecutionStartEvent) {
  const { terminal, execution } = event;
  const parser = new OscParser((notification) => {
    void handleOscNotification(terminal, notification);
  });

  const stream = execution.read() as AsyncIterable<string | Uint8Array>;
  try {
    for await (const data of stream) {
      if (typeof data === "string") {
        parser.feed(data);
        continue;
      }

      parser.feed(Buffer.from(data).toString());
    }
  } catch (error) {
    log("Terminal data stream ended with error", { error: formatError(error) });
  }
}

async function handleOscNotification(terminal: vscode.Terminal, notification: ParsedNotification) {
  const terminalPid = await resolveTerminalPid(terminal);
  if (!terminalPid) {
    log("Skipping notification - could not resolve terminal PID");
    return;
  }

  if (shouldSkipNotification(terminal)) {
    return;
  }

  showNotification(terminal, terminalPid, notification);
}

function shouldSkipNotification(terminal: vscode.Terminal) {
  const windowFocused = vscode.window.state.focused;
  const activeTerminal = vscode.window.activeTerminal;
  const piTerminalActive = activeTerminal === terminal;

  log("Checking notification conditions", { windowFocused, piTerminalActive });

  if (windowFocused && piTerminalActive) {
    log("Skipping notification - Pi terminal is focused");
    return true;
  }

  return false;
}

async function clearNotificationIfTerminalFocused() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal || !vscode.window.state.focused) {
    return;
  }

  const pid = await resolveTerminalPid(terminal);
  if (pid && activeNotificationPids.has(pid)) {
    log("Clearing notification - terminal focused", { pid });
    activeNotificationPids.delete(pid);
    removeNotification(`pi-terminal-${pid}`, log);
  }
}

function cleanupTerminalState(terminal: vscode.Terminal) {
  const pid = terminalPidMap.get(terminal);
  if (pid) {
    activeNotificationPids.delete(pid);
    removeNotification(`pi-terminal-${pid}`, log);
    terminalPidMap.delete(terminal);
  }
}

function showNotification(
  terminal: vscode.Terminal,
  terminalPid: number,
  notification: ParsedNotification,
) {
  const title = buildNotificationTitle(notification.title);
  const message = buildNotificationMessage(notification.body, terminal);

  log("Showing MacOS notification", {
    title,
    bodyLength: notification.body.length,
    terminalName: terminal.name,
    terminalPid,
  });

  activeNotificationPids.add(terminalPid);
  terminalPidMap.set(terminal, terminalPid);

  sendOsNotification(terminal, terminalPid, title, message);
}

function buildNotificationTitle(oscTitle?: string) {
  const trimmed = oscTitle?.trim();
  const parts = [NOTIFICATION_TITLE, trimmed].filter(Boolean) as string[];
  return parts.join(" — ");
}

function buildNotificationMessage(oscBody: string, terminal: vscode.Terminal) {
  const workspacePath = getWorkspaceLaunchPath();
  const workspaceLine = `Workspace: ${workspacePath ?? "Unknown"}`;
  const terminalLine = `Terminal: ${terminal.name}`;
  const body = oscBody.trim();
  const parts = [body, terminalLine, workspaceLine].filter(Boolean);
  return parts.join("\n");
}

function sendOsNotification(
  terminal: vscode.Terminal,
  terminalPid: number,
  title: string,
  message: string,
) {
  const groupId = `pi-terminal-${terminalPid}`;

  notify(
    {
      title,
      message,
      group: groupId,
    },
    (error: Error | null, _response?: string, metadata?: NotificationResponse) => {
      activeNotificationPids.delete(terminalPid);

      if (error) {
        log("MacOS notification failed", { error: formatError(error) });
        return;
      }

      if (metadata?.activationType === "contentsClicked") {
        void handleFocusTerminalAction(terminal);
      }
    },
    log,
  );
}

async function handleFocusTerminalAction(terminal: vscode.Terminal) {
  log("Focus Terminal action selected", { terminalName: terminal.name });
  const localWorkspacePath = getWorkspaceLaunchPath();
  if (localWorkspacePath) {
    await bringWindowToForeground(localWorkspacePath);
  } else {
    log("No workspace path resolved for local window");
  }

  await focusTerminalPanel(terminal);
}

async function focusTerminalPanel(terminal: vscode.Terminal) {
  terminal.show(true);
  await vscode.commands.executeCommand("workbench.action.terminal.focus");
  log("Focused terminal panel");
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

async function resolveTerminalPid(terminal: vscode.Terminal) {
  const cached = terminalPidMap.get(terminal);
  if (cached) {
    return cached;
  }

  try {
    const pid = await terminal.processId;
    if (typeof pid === "number") {
      terminalPidMap.set(terminal, pid);
      return pid;
    }
  } catch (error) {
    log("Failed to read terminal processId", { error: formatError(error) });
  }

  return undefined;
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
