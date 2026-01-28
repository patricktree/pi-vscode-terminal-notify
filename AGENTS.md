# Agent Notes

## Repo Structure

- `packages/vscode-extension/`: VS Code extension that exposes window focus + active terminal PID over a Unix socket and shows macOS notifications.
- `packages/pi-extension/`: Pi extension that sends `maybeNotify` to all VS Code sockets on `agent_end` with ancestor PIDs; the VS Code extension decides whether to show a notification.
- `packages/shared/`: Shared socket types/utilities used by both extensions.

## Validation

Run the following in the repo root before finishing changes:

```bash
pnpm -r run build
pnpm -r run lint:fix
```
