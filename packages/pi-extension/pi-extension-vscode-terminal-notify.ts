import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  assertDarwin,
  formatError,
  listSocketPaths,
  type VscodeTerminalNotifySocketProto,
} from "@patricktree/pi-vscode-terminal-notify.shared";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

const MAX_ANCESTOR_DEPTH = 15;
const EXTENSION_LOG_PATH = path.join(
  os.homedir(),
  ".pi",
  "pi-vscode-terminal-notify",
  "pi-extension-log.txt",
);

export default function registerVscodeSocketNotify(pi: ExtensionAPI) {
  assertDarwin();
  pi.on("agent_end", async () => {
    const ancestorPids = await getAncestorPids();
    await sendMaybeNotify(ancestorPids);
  });
}

async function getAncestorPids(maxDepth = MAX_ANCESTOR_DEPTH) {
  const ancestors: number[] = [];
  let currentPid = process.pid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    ancestors.push(currentPid);
    if (currentPid === 1) {
      break;
    }

    const parentPid = await getParentPid(currentPid);
    if (!parentPid || parentPid === currentPid) {
      break;
    }

    currentPid = parentPid;
  }

  log("Collected ancestor PIDs", { ancestors });
  return ancestors;
}

async function sendMaybeNotify(ancestorPids: number[]) {
  const socketPaths = await listSocketPaths(log);

  if (socketPaths.length === 0) {
    log("No VS Code sockets found, skipping notification");
    return;
  }

  log("Sending maybeNotify to VS Code windows", { socketCount: socketPaths.length });
  await Promise.all(socketPaths.map((socketPath) => maybeNotifySocket(socketPath, ancestorPids)));
  log("maybeNotify sent to all sockets");
}

async function maybeNotifySocket(socketPath: string, ancestorPids: number[]) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });

    socket.on("connect", () => {
      log("Sending maybeNotify command", { socketPath });
      socket.write(
        `${JSON.stringify({ command: "maybeNotify", ancestorPids } satisfies VscodeTerminalNotifySocketProto["maybeNotify"]["request"])}\n`,
      );
      socket.end();
    });

    socket.on("error", (error) => {
      log("maybeNotify socket error", { socketPath, error: formatError(error) });
      reject(error);
    });

    socket.on("close", () => {
      resolve();
    });
  });
}

async function getParentPid(pid: number) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    const parent = Number.isNaN(parsed) ? undefined : parsed;
    log("Fetched parent PID", { pid, parent });
    return parent;
  } catch (error) {
    log("Failed to fetch parent PID", { pid, error: formatError(error) });
    return undefined;
  }
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

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  const line = `[Pi Notify] ${timestamp} ${message}${suffix}\n`;

  void (async () => {
    try {
      await fs.promises.mkdir(path.dirname(EXTENSION_LOG_PATH), {
        recursive: true,
      });
      await fs.promises.appendFile(EXTENSION_LOG_PATH, line, "utf8");
    } catch (error) {
      const errorSuffix = JSON.stringify({ error: formatError(error) });
      process.stderr.write(`${line.trimEnd()} ${errorSuffix}\n`);
    }
  })();
}
