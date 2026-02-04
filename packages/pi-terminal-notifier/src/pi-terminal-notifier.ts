/**
 * Lightweight wrapper around the vendored pi-terminal-notifier V3 binary.
 * Replaces node-notifier for macOS notifications.
 */
import { execFile, spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NOTIFIER_PATH = path.join(
  __dirname,
  "..",
  "vendor",
  "pi-terminal-notifier.app",
  "Contents",
  "MacOS",
  "pi-terminal-notifier",
);

export type NotificationOptions = {
  title?: string;
  subtitle?: string;
  message: string;
  sound?: string | boolean;
  group?: string;
  contentImage?: string;
  open?: string;
  execute?: string;
  activate?: string;
  actions?: string[];
  timeout?: number;
  ignoreDnD?: boolean;
};

export type NotificationResponse = {
  activationType?: "contentsClicked" | "actionClicked" | "timeout" | "closed";
  activationValue?: string;
};

export type NotificationCallback = (
  error: Error | null,
  response?: string,
  metadata?: NotificationResponse,
) => void;

export type LogFunction = (message: string, data?: unknown) => void;

/**
 * Ensure the vendored binary is executable.
 *
 * VSIX packages are ZIP archives which do not preserve Unix file permissions,
 * so the executable bit is lost after Marketplace install.  Call this once
 * during extension activation.
 */
export async function ensureExecutable(): Promise<void> {
  await chmod(NOTIFIER_PATH, 0o755);
}

/**
 * Send a macOS notification using the vendored pi-terminal-notifier.
 */
export function notify(
  options: NotificationOptions,
  callback?: NotificationCallback,
  log?: LogFunction,
): void {
  const args = buildArgs(options);

  log?.("Invoking pi-terminal-notifier", { path: NOTIFIER_PATH, args });

  execFile(NOTIFIER_PATH, args, (error, stdout, stderr) => {
    if (error) {
      log?.("pi-terminal-notifier failed", { error: error.message, stderr });
      callback?.(error);
      return;
    }

    log?.("pi-terminal-notifier completed", { stdout: stdout.trim(), stderr });

    const response = parseResponse(stdout.trim());
    log?.("Parsed notification response", response);

    callback?.(null, response.activationType, response);
  });
}

function buildArgs(options: NotificationOptions): string[] {
  const args: string[] = [];

  args.push("-message", options.message);

  if (options.title) {
    args.push("-title", options.title);
  }

  if (options.subtitle) {
    args.push("-subtitle", options.subtitle);
  }

  if (options.sound === true) {
    args.push("-sound", "default");
  } else if (typeof options.sound === "string") {
    args.push("-sound", options.sound);
  }

  if (options.group) {
    args.push("-group", options.group);
  }

  if (options.contentImage) {
    args.push("-contentImage", options.contentImage);
  }

  if (options.open) {
    args.push("-open", options.open);
  }

  if (options.execute) {
    args.push("-execute", options.execute);
  }

  if (options.activate) {
    args.push("-activate", options.activate);
  }

  if (options.actions) {
    for (const action of options.actions) {
      args.push("-action", action);
    }
  }

  if (options.timeout !== undefined) {
    /*
     * pi-terminal-notifier V3 doesn't have a direct timeout flag.
     * The notification will persist until user interaction or system dismissal.
     * This is left here for API compatibility.
     */
  }

  if (options.ignoreDnD) {
    args.push("-ignoreDnD");
  }

  return args;
}

function parseResponse(stdout: string): NotificationResponse {
  /*
   * pi-terminal-notifier V3 output format (patched):
   * - Empty or no output: notification was dismissed/timed out
   * - "CLICKED": notification body was clicked
   * - "ACTION:identifier": action button was clicked
   * - "ACTION:identifier:text": text input action response
   */
  if (!stdout) {
    return { activationType: "closed" };
  }

  const normalized = stdout.toLowerCase().trim();

  if (normalized === "clicked") {
    return { activationType: "contentsClicked" };
  }

  if (normalized === "timeout" || normalized === "timedout") {
    return { activationType: "timeout" };
  }

  if (normalized.startsWith("action:")) {
    const parts = stdout.split(":");
    return {
      activationType: "actionClicked",
      activationValue: parts.slice(1).join(":"),
    };
  }

  /* Fallback for unexpected output */
  return { activationType: "closed" };
}

/**
 * Get the path to the vendored pi-terminal-notifier binary.
 * Useful for debugging or direct invocation.
 */
export function getNotifierPath(): string {
  return NOTIFIER_PATH;
}

/**
 * Remove a notification by group ID.
 */
export function removeNotification(group: string, log?: LogFunction): void {
  log?.("Removing notification by group", { group, path: NOTIFIER_PATH });

  const child = spawn(NOTIFIER_PATH, ["--debug", "-remove", group], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
    log?.("Remove stdout chunk", { data: data.toString().trim() });
  });

  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
    log?.("Remove stderr chunk", { data: data.toString().trim() });
  });

  child.on("error", (err) => {
    log?.("Remove process error", { group, error: err.message });
  });

  child.on("close", (code, signal) => {
    log?.("Remove process closed", { group, code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
  });

  child.on("exit", (code, signal) => {
    log?.("Remove process exit", { group, code, signal });
  });

  log?.("Remove process spawned", { pid: child.pid });
}
