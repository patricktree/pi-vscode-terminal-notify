# Pi ↔ VS Code Terminal Notification Socket

This repository contains two pieces:

1. **VS Code extension** that exposes window focus + active terminal PID over a Unix socket.
2. **Pi extension** that queries the socket on `agent_end` and sends a macOS notification when Pi is not the active VS Code terminal.

## VS Code Extension

Location: `packages/vscode-extension/`

```bash
cd packages/vscode-extension
pnpm install
pnpm run build
```

Load the extension in VS Code (Run → Start Debugging for extension dev) or package it using `vsce`.

The extension listens on per-window sockets under:

```txt
~/.pi/vscode-terminal-notification/vscode-terminal-notification-<pid>.sock
```

## Pi Extension

Location: `packages/pi-extension/`

Copy or symlink the file into your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp packages/pi-extension/vscode-terminal-notify.ts ~/.pi/agent/extensions/
```

Restart Pi.

## Behavior

When Pi finishes a prompt (`agent_end`), it:

- Builds the ancestor PID chain (up to 15 levels).
- Queries the VS Code socket for focus + active terminal.
- Sends a macOS notification if VS Code is unfocused or another terminal is active.

If `terminal-notifier` is installed (`brew install terminal-notifier`), clicking the notification focuses the VS Code window that owns the Pi terminal (even with multiple windows). If it is missing, Pi falls back to `osascript` (no click handler).
