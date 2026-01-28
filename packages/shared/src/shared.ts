import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zod from "zod";

export const VscodeTerminalNotifySocketProtoSchema = zod.object({
  maybeNotify: zod.object({
    request: zod.object({
      command: zod.literal("maybeNotify"),
      ancestorPids: zod.array(zod.number()),
    }),
    response: zod.never(),
  }),
  locate: zod.object({
    request: zod.object({
      command: zod.literal("locate"),
      ancestorPids: zod.array(zod.number()),
    }),
    response: zod.object({
      ownsTerminal: zod.boolean(),
      workspacePath: zod.string().nullable(),
    }),
  }),
});

export type VscodeTerminalNotifySocketProto = zod.infer<
  typeof VscodeTerminalNotifySocketProtoSchema
>;

/** Union schema for parsing any incoming socket request */
export const VscodeTerminalNotifySocketRequestSchema = zod.union([
  VscodeTerminalNotifySocketProtoSchema.shape.maybeNotify.shape.request,
  VscodeTerminalNotifySocketProtoSchema.shape.locate.shape.request,
]);

export type VscodeTerminalNotifySocketRequest = zod.infer<
  typeof VscodeTerminalNotifySocketRequestSchema
>;

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
