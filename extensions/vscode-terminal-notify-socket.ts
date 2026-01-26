import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const SOCKET_RELATIVE_PATH = path.join(".pi", "vscode-pi.sock");
const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_MESSAGE = "Pi is waiting for input";
const MAX_ANCESTOR_DEPTH = 15;

function getSocketPath() {
  return path.join(os.homedir(), SOCKET_RELATIVE_PATH);
}

function execFileAsync(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getParentPid(pid: number) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)]);
    const parsed = parseInt(stdout.trim(), 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch (error) {
    return undefined;
  }
}

async function getAncestorPids(maxDepth = MAX_ANCESTOR_DEPTH) {
  const ancestors: number[] = [];
  let currentPid = process.pid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    ancestors.push(currentPid);
    if (currentPid === 1) break;

    const parentPid = await getParentPid(currentPid);
    if (!parentPid || parentPid === currentPid) break;

    currentPid = parentPid;
  }

  return ancestors;
}

async function queryVscode(ancestorPids: number[]) {
  const socketPath = getSocketPath();

  return new Promise<{ focused: boolean; piTerminalActive: boolean } | undefined>((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ancestorPids })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      try {
        const payload = JSON.parse(line);
        if (typeof payload?.focused === "boolean" && typeof payload?.piTerminalActive === "boolean") {
          resolve({ focused: payload.focused, piTerminalActive: payload.piTerminalActive });
        } else {
          resolve(undefined);
        }
      } catch (error) {
        resolve(undefined);
      }

      socket.end();
    });

    socket.on("error", () => {
      resolve(undefined);
    });

    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

function sendNotification() {
  return execFileAsync("osascript", [
    "-e",
    `display notification ${JSON.stringify(NOTIFICATION_MESSAGE)} with title ${JSON.stringify(
      NOTIFICATION_TITLE
    )}`,
  ]).catch(() => undefined);
}

export default function registerVscodeSocketNotify(pi: ExtensionAPI) {
  pi.on("agent_end", async () => {
    const ancestorPids = await getAncestorPids();
    const response = await queryVscode(ancestorPids);

    const shouldNotify = !response || !response.focused || !response.piTerminalActive;
    if (shouldNotify) {
      await sendNotification();
    }
  });
}
