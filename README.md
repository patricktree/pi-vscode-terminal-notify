# Pi ↔ VS Code Terminal Notification (OSC 777)

macOS-only notifications: the VS Code extension throws on non-darwin platforms, while the Pi extension emits OSC 777 on all platforms.

This repository contains three pieces:

1. **VS Code extension** that listens for OSC 777 notifications in terminal output and shows macOS notifications when Pi is not the active terminal.
2. **Pi extension** that emits OSC 777 notifications on `agent_end` with a short summary of the last assistant message.
3. **Shared package** with small helper utilities used by both extensions.

## Shared Package

Location: `packages/shared/`

## VS Code Extension

Location: `packages/vscode-extension/`

```bash
pnpm install
pnpm --filter pi-vscode-terminal-notify run build
```

Load the extension in VS Code (Command Palette → "Developer: Install Extension from Location...") or package it using `vsce`.

### Notification Permissions

The VS Code extension uses a vendored `terminal-notifier` app bundle to display macOS notifications. On first use, you must grant notification permissions:

1. Open **System Settings → Notifications**
2. Find **"terminal-notifier"** with the Pi logo in the list
3. Enable **"Allow Notifications"**

Without this permission, notifications will silently fail to appear.

### OSC 777 Flow

The Pi extension emits an OSC 777 notification in the terminal output:

```txt
ESC ] 777 ; notify ; <title> ; <body> BEL
```

The VS Code extension reads terminal output (including tmux passthrough) and triggers the macOS notification UI when it sees the OSC 777 sequence.

## Pi Extension

Location: `packages/pi-extension/`

This extension depends on the shared package, so install it via Pi packages using a local path (Pi will resolve dependencies from this repo).

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

- Extracts the last assistant text response.
- Emits an OSC 777 notification to the terminal (title + truncated body).
- VS Code parses the OSC 777 message and decides whether to show a macOS notification based on focus state.

Clicking the notification focuses the owning VS Code window and terminal when possible.

### Logging

- Pi extension logs to `~/.pi/pi-vscode-terminal-notify/pi-extension-log.txt`.
- VS Code extension logs to the "Pi Terminal Notify" output channel (and the extension host console).
