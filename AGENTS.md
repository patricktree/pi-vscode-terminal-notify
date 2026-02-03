# Agent Notes

## Repo Structure

- `packages/vscode-extension/`: VS Code extension that listens for OSC 777 in terminal output and shows macOS notifications.
- `packages/pi-extension/`: Pi extension that emits OSC 777 notifications on `agent_end` with the last assistant response.
- `packages/shared/`: Shared helper utilities used by both extensions.

## Validation

Run the following in the repo root before finishing changes:

```bash
pnpm -r run build
pnpm -r run lint:fix
```

## Publishing

- Add a Changeset (`pnpm exec changeset`) for user-facing package changes; omit for tooling-only tweaks unless publishing impact.
