# Pi Terminal Notify (OSC 777)

macOS-only VS Code extension that listens for OSC 777 notifications in terminal output and shows macOS notifications when VS Code is not focused.

## Features

- Parses OSC 777 `notify` sequences from terminal output (including tmux passthrough).
- Shows macOS notifications when the Pi terminal is not active.
- Clicking a notification focuses the owning VS Code window and terminal.

## Requirements

- macOS (the extension throws on non-darwin platforms).
- A tool that emits OSC 777 sequences (the Pi extension in <https://github.com/patricktree/pi-vscode-terminal-notify/tree/main/packages/pi-extension> does this on `agent_end`).

### OSC 777 Format

```text
ESC ] 777 ; notify ; <title> ; <body> BEL
```

## Notification Permissions

The extension uses a vendored `terminal-notifier` app bundle for macOS notifications. On first use, grant notification permissions:

1. Open **System Settings → Notifications**
2. Find **"terminal-notifier"** with the Pi logo
3. Enable **"Allow Notifications"**

## Logging

Logs are written to the **"Pi Terminal Notify"** output channel (and extension host console).
