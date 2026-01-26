# Pi ↔ VS Code Terminal Notification Socket

This repository contains two pieces:

1. **VS Code extension** that exposes window focus + active terminal PID over a Unix socket.
2. **Pi extension** that queries the socket on `agent_end` and sends a macOS notification when Pi is not the active VS Code terminal.

## VS Code Extension

Location: `packages/vscode-extension`

```bash
cd packages/vscode-extension
npm install
npm run compile
```

Load the extension in VS Code (Run → Start Debugging for extension dev) or package it using `vsce`.

The extension listens on:

```
~/.pi/vscode-pi.sock
```

## Pi Extension

Location: `extensions/vscode-terminal-notify-socket.ts`

Copy or symlink the file into your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/vscode-terminal-notify-socket.ts ~/.pi/agent/extensions/
```

Restart Pi or start it with:

```bash
pi -e ~/.pi/agent/extensions/vscode-terminal-notify-socket.ts
```

## Behavior

When Pi finishes a prompt (`agent_end`), it:

- Builds the ancestor PID chain (up to 15 levels).
- Queries the VS Code socket for focus + active terminal.
- Sends a macOS notification if VS Code is unfocused or another terminal is active.

If the socket is unavailable, it falls back to sending a notification.
