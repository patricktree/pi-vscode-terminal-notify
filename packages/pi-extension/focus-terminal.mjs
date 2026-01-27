/* eslint-disable unicorn/no-process-exit, n/no-process-exit */
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

const logPath = path.join(
  os.homedir(),
  ".pi",
  "vscode-terminal-notification",
  "focus-script-log.txt",
);
const dir = process.argv[2];
const ancestors = (process.argv[3] || "")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value));

if (!dir || ancestors.length === 0) {
  await log("Missing directory or ancestors", { dir, ancestors });
  process.exit(0);
}

await log("Starting focus script", { dir, ancestors });

let entries = [];
try {
  entries = await readdir(dir);
} catch (error) {
  await log("Failed to read directory", { dir, error: formatError(error) });
  process.exit(0);
}

await Promise.all(
  entries
    .filter((entry) => entry.endsWith(".sock"))
    .map((entry) => {
      const socketPath = path.join(dir, entry);
      return /** @type {Promise<void>} */ (
        new Promise((resolve, reject) => {
          const socket = createConnection({ path: socketPath });
          socket.on("connect", () => {
            void log("Connected to socket", { socketPath });
            socket.write(`${JSON.stringify({ command: "focus", ancestorPids: ancestors })}\n`);
            socket.end();
            resolve();
          });
          socket.on(
            "error",
            /** @param {Error} error */ (error) => {
              void log("Socket error", { socketPath, error: formatError(error) });
              reject(error);
            },
          );
        })
      );
    }),
);

/**
 * @param {string} message
 * @param {unknown} [data]
 */
async function log(message, data) {
  const timestamp = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  const line = `[Pi Focus Script] ${timestamp} ${message}${suffix}\n`;
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, line, "utf8");
  } catch {
    // ignore logging failures
  }
}

/** @param {unknown} error */
function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}
