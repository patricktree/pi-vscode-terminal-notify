# Pi Terminal Notify for VS Code

macOS notifications for the [Pi Coding Agent](https://pi.dev) — get notified when Pi is waiting for input and the terminal is not focused.

![Example macOS notification from Pi](packages/vscode-extension/assets/notification-example.png)

## Features

- Native macOS notifications when the Pi terminal is waiting for input but not visible.
- Click a notification to focus the owning VS Code window and terminal.
- Notifications auto-dismiss when you switch to the terminal yourself.
- Grouped per terminal — new notifications replace stale ones.

## Installation

Two components are needed: a **VS Code extension** (receives and displays notifications) and a **Pi extension** (emits them).

### 1. VS Code extension

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=patricktree.pi-vscode-terminal-notify).

On first use, macOS will prompt for notification permissions — click **Allow**.
If you missed the prompt, enable it manually: **System Settings → Notifications → pi-terminal-notifier → Allow Notifications**.

### 2. Pi extension

Install from npm:

```bash
pi install @patricktree/pi-vscode-terminal-notify.pi-extension
```

Project-local install:

```bash
pi install @patricktree/pi-vscode-terminal-notify.pi-extension -l
```

npm package: [@patricktree/pi-vscode-terminal-notify.pi-extension](https://www.npmjs.com/package/@patricktree/pi-vscode-terminal-notify.pi-extension).

## How it works

The notification pipeline has three stages:

1. **Pi extension emits an OSC 777 escape sequence.**
   When the Pi Coding Agent finishes a turn (`agent_end`), the [Pi extension](packages/pi-extension/) extracts the last assistant message, truncates it, and writes an [OSC 777](https://iterm2.com/documentation-escape-codes.html) `notify` sequence (`ESC ] 777 ; notify ; <title> ; <body> BEL`) to the terminal's stdout.

2. **VS Code extension parses the terminal stream.**
   The extension listens for every shell execution via `onDidStartTerminalShellExecution`, reads the output stream, and feeds each chunk into an OSC parser that detects `777;notify` sequences (including tmux passthrough-wrapped ones). When a notification is parsed, the extension checks whether the originating terminal is currently visible and focused — if it is, the notification is suppressed.

3. **Native macOS notification is shown.**
   If the terminal is not focused, the extension invokes [pi-terminal-notifier](packages/pi-terminal-notifier/) (a vendored macOS notification binary) to post a native notification. Notifications are grouped per terminal PID so newer ones replace stale ones. Clicking a notification brings the VS Code window to the foreground and focuses the originating terminal. Notifications are automatically cleared when the user switches to the terminal on their own.

## Repository structure

| Package                                                    | Description                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`vscode-extension`](packages/vscode-extension/)           | VS Code extension shell — wires core logic to VS Code APIs.                     |
| [`vscode-extension-core`](packages/vscode-extension-core/) | Publishable core logic — OSC 777 parser, notification dispatch, focus handling. |
| [`pi-extension`](packages/pi-extension/)                   | Pi extension — emits OSC 777 on `agent_end` with the last assistant response.   |
| [`pi-terminal-notifier`](packages/pi-terminal-notifier/)   | Vendored macOS notification binary wrapper.                                     |
| [`shared`](packages/shared/)                               | Shared utilities (`assertDarwin`, `formatError`, `sanitizeOscValue`).           |

## Development

```bash
pnpm install
pnpm -r run build
pnpm -r run lint:fix
```

Load the VS Code extension locally via **Command Palette → Developer: Install Extension from Location…** pointing at `packages/vscode-extension/`.

## Logging

- **VS Code extension** → "Pi Terminal Notify" output channel (and extension host console).
- **Pi extension** → `~/.pi/pi-vscode-terminal-notify/pi-extension-log.txt`.

## Attribution

- The VS Code extension is derived from [`vscode-terminal-osc-notifier`](https://github.com/wbopan/vscode-terminal-osc-notifier) (MIT).
- The Pi extension is derived from [`notify.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/notify.ts) (Apache-2.0).

See [NOTICE](NOTICE) for details.

## License

[Apache-2.0](LICENSE)
