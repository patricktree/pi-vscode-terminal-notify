import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SocketRequestPayload =
  | {
      command: "query";
      ancestorPids: number[];
    }
  | {
      command: "notify";
      ancestorPids: number[];
    }
  | {
      command: "locate";
      ancestorPids: number[];
    };

export type SocketResponsePayload = {
  windowFocused: boolean;
  piTerminalActive: boolean;
};

export type SocketLocateResponsePayload = {
  ownsTerminal: boolean;
  workspacePath: string | null;
};

export function getSocketDirectory() {
  return path.join(os.homedir(), ".pi", "pi-vscode-terminal-notify");
}

export function assertDarwin() {
  if (process.platform !== "darwin") {
    throw new Error("Pi VS Code terminal notifications are only supported on MacOS");
  }
}

export function formatError(error: unknown): string {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSocketPayload(value: unknown): value is SocketResponsePayload {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value["windowFocused"] === "boolean" && typeof value["piTerminalActive"] === "boolean"
  );
}

export async function listSocketPaths(
  log: (message: string, data?: unknown) => void,
): Promise<string[]> {
  const socketDirectory = getSocketDirectory();
  try {
    const entries = await fs.promises.readdir(socketDirectory);
    const paths = entries
      .filter((entry) => entry.endsWith(".sock"))
      .map((entry) => path.join(socketDirectory, entry));
    log("Listed socket paths", { count: paths.length, paths });
    return paths;
  } catch (error) {
    log("Failed to list socket paths", { error: formatError(error) });
    return [];
  }
}
