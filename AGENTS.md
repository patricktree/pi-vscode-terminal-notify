# Agent Notes

## Repo Structure

- `packages/vscode-extension-core/`: Publishable core logic — OSC 777 parser, shared utilities, and pi-terminal-notifier re-exports.
- `packages/vscode-extension/`: VS Code extension shell that wires core logic to VS Code APIs.
- `packages/pi-extension/`: Pi extension that emits OSC 777 notifications on `agent_end` with the last assistant response.
- `packages/shared/`: Shared helper utilities (assertDarwin, formatError, sanitizeOscValue).
- `packages/pi-terminal-notifier/`: Vendored macOS notification binary wrapper.

## Validation

Run the following in the repo root before finishing changes:

```bash
pnpm -r run build
pnpm -r run lint:fix
```

## Publishing

- Add a Changeset (`pnpm exec changeset`) for user-facing package changes; omit for tooling-only tweaks unless publishing impact.
