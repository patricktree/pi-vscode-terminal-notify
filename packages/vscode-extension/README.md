# Pi Coding Agent Notifications

VS Code extension that shows macOS notifications when the [Pi Coding Agent](https://pi.dev) is waiting for input and the terminal is not focused.

![Example macOS notification from Pi](https://raw.githubusercontent.com/patricktree/pi-vscode-terminal-notify/main/packages/vscode-extension/assets/notification-example.png)

## Features

- Native macOS notifications when Pi finishes a turn and the terminal is not visible.
- Click a notification to focus the owning VS Code window and terminal.
- Notifications auto-dismiss when you switch to the terminal yourself.
- Grouped per terminal — new notifications replace stale ones.

## Requirements

- **macOS** — this extension uses native macOS notifications and is not available on other platforms.
- **[`pi-vscode-terminal-notification`](https://www.npmjs.com/package/pi-vscode-terminal-notification)** — companion Pi package that emits notifications when Pi finishes a turn. Without it, this VS Code extension has nothing to listen for.

## Installation

1. Install this extension from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=patricktree.pi-vscode-terminal-notify).
2. Install the companion Pi package:

   ```bash
   pi install pi-vscode-terminal-notification
   ```

3. On first use, macOS shows a permission dialog — click **Allow**:
   ![macOS notification permission dialog for pi-terminal-notifier](https://raw.githubusercontent.com/patricktree/pi-vscode-terminal-notify/main/packages/vscode-extension/assets/pi-terminal-notifier-allow-dialog.png)

## How it works

1. The Pi extension writes an OSC 777 `notify` escape sequence to the terminal when Pi finishes a turn.
2. This VS Code extension reads the terminal output stream and parses OSC 777 sequences (including tmux passthrough-wrapped ones).
3. If the terminal is not focused, a native macOS notification is shown. Clicking it brings the VS Code window and terminal to the foreground.

## Troubleshooting

### Notifications not appearing

- **Notification permissions** — open **System Settings → Notifications**, find **pi-terminal-notifier**, and enable **Allow Notifications**.
- **Pi extension not installed** — this VS Code extension only listens; install the Pi package via `pi install pi-vscode-terminal-notification`.
- **Terminal is focused** — notifications are intentionally suppressed when the Pi terminal is already visible and focused.

### Checking logs

Logs are written to the **"Pi Terminal Notify"** output channel — open it via **Command Palette → Output: Show Output Channel → Pi Terminal Notify**.

## Attribution

Derived from Pan Wenbo's [`vscode-terminal-osc-notifier`](https://github.com/wbopan/vscode-terminal-osc-notifier) (MIT).

## Links

- [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=patricktree.pi-vscode-terminal-notify)
- [Companion Pi package on npm](https://www.npmjs.com/package/pi-vscode-terminal-notification)
- [Source code](https://github.com/patricktree/pi-vscode-terminal-notify)
- [Issue tracker](https://github.com/patricktree/pi-vscode-terminal-notify/issues)
- [Pi Coding Agent](https://pi.dev)
