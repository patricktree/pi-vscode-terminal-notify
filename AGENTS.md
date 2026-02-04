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

### Versioning

After adding changesets, run the root `version` script to bump all versions (including the VS Code extension sync):

```bash
pnpm run version
```

### VS Code Extension → Marketplace

```bash
pnpm install --frozen-lockfile && \
    pnpm -r run build && \
    pnpm -r run lint && \
    cd packages/vscode-extension && \
    rm -rf ./node_modules && \
    npm install --omit=dev --no-package-lock && \
    pnpm dlx @vscode/vsce package --allow-unused-files-pattern
```

Publish the VSIX:

```bash
cd $VSCE_PACKAGING_DIR && pnpm dlx @vscode/vsce publish --packagePath ./pi-vscode-terminal-notify-*.vsix
```
