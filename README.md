# Pi ↔ VS Code Terminal Notification Socket

This repository contains two pieces:

1. **VS Code extension** that exposes window focus + active terminal PID over a Unix socket and shows macOS notifications.
2. **Pi extension** that queries the socket on `agent_end` and triggers notifications when Pi is not the active VS Code terminal.

## VS Code Extension

Location: `packages/vscode-extension/`

```bash
pnpm install
pnpm --filter pi-vscode-terminal-notify.vscode-extension run build
```

Load the extension in VS Code (Command Palette → "Developer: Install Extension from Location...") or package it using `vsce`.

The extension listens on per-window sockets under:

```txt
~/.pi/pi-vscode-terminal-notify/pi-vscode-terminal-notify-<pid>.sock
```

### Socket API

Each socket accepts newline-delimited JSON commands:

- `query` → returns `{ windowFocused, piTerminalActive }` for the current VS Code window.
- `notify` → shows a macOS notification with workspace + terminal details.
- `locate` → returns `{ ownsTerminal, workspacePath }` for a given ancestor PID chain (used to focus the owning window).

Notifications are macOS-only; other platforms will reject the `notify` command.

## Pi Extension

Location: `packages/pi-extension/`

Copy or symlink the file into your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp packages/pi-extension/pi-extension-vscode-terminal-notify.ts ~/.pi/agent/extensions/
```

Restart Pi.

### Behavior

When Pi finishes a prompt (`agent_end`), it:

- Builds the ancestor PID chain (up to 15 levels).
- Queries every VS Code socket for focus + active terminal status.
- Sends a `notify` command to all sockets if none report an active Pi terminal.

Clicking the notification focuses the owning VS Code window and terminal when possible.

### Logging

- Pi extension logs to `~/.pi/pi-vscode-terminal-notify/pi-extension-log.txt`.
- VS Code extension logs to the "Pi Terminal Notify" output channel (and the extension host console).
