# Agent Notes

## Repo Structure

- `packages/vscode-extension/`: VS Code extension that exposes window focus + active terminal PID over a Unix socket and shows macOS notifications.
- `packages/pi-extension/`: Pi extension that queries the socket on `agent_end` and triggers notifications when Pi is not the active VS Code terminal.
- `packages/shared/`: Shared socket types/utilities used by both extensions.

## Validation

Run the following in the repo root before finishing changes:

```bash
pnpm -r run build
pnpm -r run lint:fix
```
