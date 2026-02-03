// Derived from https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/notify.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatError, sanitizeOscValue } from "@patricktree/pi-vscode-terminal-notify.shared";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BODY_LENGTH = 200;
const EXTENSION_LOG_PATH = path.join(
  os.homedir(),
  ".pi",
  "pi-vscode-terminal-notify",
  "pi-extension-log.txt",
);

type Message = { role?: string; content?: unknown };

type TextPart = { type: "text"; text: string };

const isTextPart = (part: unknown): part is TextPart => {
  if (!part || typeof part !== "object") {
    return false;
  }

  const record = part as Record<string, unknown>;
  return record["type"] === "text" && typeof record["text"] === "string";
};

const extractLastAssistantText = (messages: Message[]): string | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") {
      continue;
    }

    const content = message.content;
    if (typeof content === "string") {
      return content.trim() || null;
    }

    if (Array.isArray(content)) {
      const text = content
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n")
        .trim();
      return text || null;
    }

    return null;
  }

  return null;
};

const normalizeNotificationText = (text: string | null): string => {
  if (!text) {
    return "";
  }

  return text.replace(/\s+/g, " ").trim();
};

const formatNotification = (text: string | null): { title: string; body: string } => {
  const normalized = normalizeNotificationText(text);
  if (!normalized) {
    return { title: "Ready for input", body: "" };
  }

  const body =
    normalized.length > MAX_BODY_LENGTH
      ? `${normalized.slice(0, MAX_BODY_LENGTH - 1)}…`
      : normalized;
  return { title: "π", body };
};

const sendOscNotification = (title: string, body: string): void => {
  // Based on https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/notify.ts
  const safeTitle = sanitizeOscValue(title);
  const safeBody = sanitizeOscValue(body);
  process.stdout.write(`\u001B]777;notify;${safeTitle};${safeBody}\u0007`);
};

export default function registerOscNotify(pi: ExtensionAPI) {
  pi.on("agent_end", (event) => {
    const lastText = extractLastAssistantText(event.messages);
    const { title, body } = formatNotification(lastText);
    sendOscNotification(title, body);
    log("Sent OSC 777 notification", { title, bodyLength: body.length });
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
