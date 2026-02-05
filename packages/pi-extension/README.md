# Pi Extension — VS Code Terminal Notify

[Pi](https://pi.dev) extension that emits [OSC 777](https://iterm2.com/documentation-escape-codes.html) terminal notifications when the coding agent finishes a turn. Paired with the [VS Code extension](../vscode-extension/), this enables native macOS notifications when Pi is waiting for input.

## What it does

On every `agent_end` event, this extension:

1. Extracts the last assistant text response from the conversation.
2. Truncates it to 200 characters.
3. Writes an OSC 777 `notify` escape sequence to stdout:

   ```text
   ESC ] 777 ; notify ; <title> ; <body> BEL
   ```

The VS Code extension picks up these sequences from the terminal output stream and shows a native macOS notification when the terminal is not focused.

## Installation

### 1. Build the workspace

This extension depends on the [`shared`](../shared/) package, so the full workspace must be built first:

```bash
pnpm install
pnpm -r run build
```

### 2. Register in Pi settings

Add the package to your Pi settings — either globally (`~/.pi/agent/settings.json`) or per-project (`.pi/settings.json`):

```json
{
  "packages": [
    "/absolute/path/to/pi-vscode-terminal-notify/packages/pi-extension"
  ]
}
```

Restart Pi.

### 3. Install the VS Code extension

Install the companion [VS Code extension](https://marketplace.visualstudio.com/items?itemName=patricktree.pi-vscode-terminal-notify) to receive and display the notifications.

## Logging

Logs are written to `~/.pi/pi-vscode-terminal-notify/pi-extension-log.txt`.

## Attribution

Derived from Armin Ronacher's [`notify.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/notify.ts) (Apache-2.0).

## Links

- [VS Code extension](../vscode-extension/) — the other half of the pipeline
- [Source code](https://github.com/patricktree/pi-vscode-terminal-notify)
- [Issue tracker](https://github.com/patricktree/pi-vscode-terminal-notify/issues)
