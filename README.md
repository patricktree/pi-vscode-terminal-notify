# Pi ↔ VS Code Terminal Notification Socket

macOS-only. Extensions throw on non-darwin platforms.

This repository contains three pieces:

1. **VS Code extension** that listens on a Unix socket, determines terminal ownership, and shows macOS notifications when Pi is not the active terminal.
2. **Pi extension** that sends `maybeNotify` to all VS Code sockets on `agent_end` with ancestor PIDs.
3. **Shared package** with socket types + helpers used by both extensions.

## Shared Package

Location: `packages/shared/`

## VS Code Extension

Location: `packages/vscode-extension/`

```bash
pnpm install
pnpm --filter pi-vscode-terminal-notify.vscode-extension run build
```

Load the extension in VS Code (Command Palette → "Developer: Install Extension from Location...") or package it using `vsce`.

### Notification Permissions

The VS Code extension uses a vendored `terminal-notifier` app bundle to display macOS notifications. On first use, you must grant notification permissions:

1. Open **System Settings → Notifications**
2. Find **"terminal-notifier"** with the Pi logo in the list
3. Enable **"Allow Notifications"**

Without this permission, notifications will silently fail to appear.

### Socket Server

The extension listens on per-window sockets under:

```txt
~/.pi/pi-vscode-terminal-notify/pi-vscode-terminal-notify-<pid>.sock
```

### Socket API

Each socket accepts newline-delimited JSON commands:

- `maybeNotify` → fire-and-forget; VS Code extension checks if the terminal (identified by ancestor PIDs) belongs to this window and is unfocused, then shows a macOS notification if appropriate.
- `locate` → returns `{ ownsTerminal, workspacePath }` for a given ancestor PID chain (used to focus the owning window).

## Pi Extension

Location: `packages/pi-extension/`

This extension now depends on the shared package, so install it via Pi packages using a local path (Pi will resolve dependencies from this repo).

Build the workspace first:

```bash
pnpm install
pnpm -r run build
```

Then add the extension file as a local package in your Pi settings (global
`~/.pi/agent/settings.json` or project `.pi/settings.json`):

```json
{
  "packages": [
    "/absolute/path/to/pi-vscode-terminal-notify/packages/pi-extension"
  ]
}
```

Restart Pi.

### Behavior

When Pi finishes a prompt (`agent_end`), it:

- Builds the ancestor PID chain (up to 15 levels).
- Sends a `maybeNotify` command to all VS Code sockets with the ancestor PIDs.
- Each VS Code extension instance determines if it owns the terminal and whether to show a notification.

Clicking the notification focuses the owning VS Code window and terminal when possible.

### Logging

- Pi extension logs to `~/.pi/pi-vscode-terminal-notify/pi-extension-log.txt`.
- VS Code extension logs to the "Pi Terminal Notify" output channel (and the extension host console).
