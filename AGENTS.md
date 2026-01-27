# Agent Notes

## Repo Structure

- `packages/vscode-extension/`: VS Code extension exposing window focus + active terminal PID via a Unix socket.
- `packages/pi-extension/`: Pi extension that listens for `agent_end` and triggers notifications via the socket.

## Validation

Run the following in the repo root before finishing changes:

```bash
pnpm -r run build
pnpm -r run lint:fix
```
