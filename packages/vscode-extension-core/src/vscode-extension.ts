import * as vscode from "vscode";
import {
  ensureExecutable,
  notify,
  removeNotification,
  type NotificationResponse,
} from "@patricktree/pi-vscode-terminal-notify.pi-terminal-notifier";
import { assertDarwin, formatError } from "@patricktree/pi-vscode-terminal-notify.shared";
import { OscParser, type ParsedNotification } from "./osc-parser.js";
import path from "node:path";
import { execFile } from "node:child_process";

const NOTIFICATION_TITLE = "Pi is waiting for input";
const VSCODE_APP_NAME = "Visual Studio Code";

let outputChannel: vscode.OutputChannel | undefined;

/** Tracks terminal PIDs with active (pending) notifications */
const activeNotificationPids = new Set<number>();
const terminalPidMap = new Map<vscode.Terminal, number>();

export async function activate(context: vscode.ExtensionContext) {
  assertDarwin();
  outputChannel = vscode.window.createOutputChannel("Pi Terminal Notify");
  log("Output channel initialized");
  log("Extension activating");

  try {
    await ensureExecutable();
    log("Notifier binary marked executable");
  } catch (error) {
    log("Failed to mark notifier binary executable", { error: formatError(error) });
  }

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
    vscode.window.tabGroups.onDidChangeTabs(() => {
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
  const inEditorArea = isTerminalInEditorArea(terminal);
  const visibleInEditorArea = inEditorArea && isTerminalVisibleInEditorArea(terminal);

  log("Checking notification conditions", {
    windowFocused,
    piTerminalActive,
    inEditorArea,
    visibleInEditorArea,
  });

  if (windowFocused && piTerminalActive) {
    /*
     * Terminal is in the editor area but its tab is hidden behind another editor —
     * activeTerminal still reports it, but the user can't see it → show notification
     */
    if (inEditorArea && !visibleInEditorArea) {
      log("Terminal is in editor area but tab is not active - showing notification");
      return false;
    }

    log(
      "Skipping notification - window focused, Pi terminal active, in editor area and visible OR not in editor area at all",
    );
    return true;
  }

  log("Showing notification - Window not focused or Pi terminal not active");

  return false;
}

async function clearNotificationIfTerminalFocused() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal || !vscode.window.state.focused) {
    return;
  }

  // Terminal is in the editor area but its tab is hidden — don't clear
  if (isTerminalInEditorArea(terminal) && !isTerminalVisibleInEditorArea(terminal)) {
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

  await focusTerminal(terminal);
}

async function focusTerminal(terminal: vscode.Terminal) {
  if (isTerminalInEditorArea(terminal)) {
    // For editor-area terminals, show(false) activates the tab and focuses it
    terminal.show(false);
    log("Focused terminal in editor area");
  } else {
    terminal.show(true);
    await vscode.commands.executeCommand("workbench.action.terminal.focus");
    log("Focused terminal in panel");
  }
}

/**
 * Check if a terminal lives in the editor area (as opposed to the bottom panel)
 * by looking for a matching TabInputTerminal tab in any tab group.
 *
 * Limitation: `TabInputTerminal` exposes no identifying properties (no PID, no URI),
 * so we correlate via `tab.label === terminal.name`. If two terminals share the same
 * name in the editor area this match is ambiguous.
 */
function isTerminalInEditorArea(terminal: vscode.Terminal): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTerminal && tab.label === terminal.name) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a terminal's editor tab is the active (visible) tab in its group.
 * Only meaningful for terminals that are in the editor area.
 *
 * Same name-matching caveat as {@link isTerminalInEditorArea}.
 */
function isTerminalVisibleInEditorArea(terminal: vscode.Terminal): boolean {
  for (const group of vscode.window.tabGroups.all) {
    const activeTab = group.activeTab;
    if (activeTab?.input instanceof vscode.TabInputTerminal && activeTab.label === terminal.name) {
      return true;
    }
  }
  return false;
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
  if (!outputChannel) {
    // extension must have been deactivated and the outputChannel disposed --> ignore
    return;
  }
  const timestamp = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  const line = `[Pi Notify] ${timestamp} ${message}${suffix}`;
  outputChannel.appendLine(line);
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
