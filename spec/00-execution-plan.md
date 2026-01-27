# Plan: VS Code ↔ Pi notification via Unix socket

## Goal

Send macOS notifications when Pi finishes a turn **unless** the Pi terminal is the **active/focused** terminal in a focused VS Code window.

## Requirements

- Identify the Pi terminal via the process ancestor chain (PID → PPID → ... → 1).
- VS Code extension must determine:
  - `windowState.focused`
  - Which terminal is **active/focused** (VS Code only exposes the active terminal)
  - The active terminal's `processId`
- Pi extension should query VS Code via a Unix domain socket.
- Socket path is local to user (e.g. `~/.pi/vscode-terminal-notification.sock`).
- One‑shot request/response per `agent_end`:
  - Request: `{ "ancestorPids": [123, 456, ...] }\n`
  - Response:
    - `{ "focused": true|false, "piTerminalActive": true|false }\n`
- Pi triggers macOS notification if `focused` is false **or** `piTerminalActive` is false.

## Plan (Implementation Steps)

### 1) Create VS Code extension (server)

- Scaffold extension in `packages/vscode-extension` (TypeScript).
- On activation:
  - Create Unix socket server at `~/.pi/vscode-terminal-notification.sock` (remove stale socket if exists).
  - Track state with VS Code APIs:
    - `window.onDidChangeWindowState`
    - `window.onDidChangeActiveTerminal`
    - `window.onDidOpenTerminal` / `window.onDidCloseTerminal`
  - Maintain access to `window.activeTerminal?.processId` for comparisons.

### 2) Determine Pi terminal by ancestor PIDs

- Preferred approach: use `process.pid` in Pi, compute ancestor PIDs via `ps`, and send the list to the VS Code extension.
- VS Code checks whether `window.activeTerminal.processId` appears in that list.

### 3) Socket protocol

- Simple line‑delimited JSON.
- Server behavior:
  - Parse request line, read `ancestorPids`.
  - Compute `focused` from `windowState`.
  - Compute `piTerminalActive` by checking if the active terminal's `processId` appears in `ancestorPids`.
  - Return JSON response line; close socket.

### 4) Create Pi extension (client)

- Extension path: `~/.pi/agent/extensions/vscode-terminal-notify.ts`.
- On `agent_end`:
  - Build ancestor PID list from `process.pid` → `ppid` → ... → 1 (cap depth: 15).
  - Connect to socket `~/.pi/vscode-terminal-notification.sock` using Node `net`.
  - Send request JSON line with `ancestorPids`.
  - Read response JSON line.
  - If `focused && piTerminalActive`: skip.
  - Else: send macOS notification via `osascript`.

### 5) Helper script / UX

- Provide a small helper (optional) to debug ancestor PID collection.
- Document usage in README.

### 6) Validation

- Test cases:
  - VS Code not focused → notify
  - VS Code focused, other terminal **active** → notify
  - VS Code focused, Pi terminal **active** → no notify
  - VS Code focused, Pi terminal exists but not active → notify
  - Socket missing/unavailable → fallback to notify (or warn once)

## Open Questions / Decisions

- Best way to associate Pi with a terminal:
  - Use ancestor PID matching between Pi's process tree and VS Code's `activeTerminal.processId`.
  - Cap PID walk depth to avoid long loops (set to 15 levels).
- Socket location and permissions (default to `~/.pi/vscode-terminal-notification.sock`).
- Notification message customization (title/body).
