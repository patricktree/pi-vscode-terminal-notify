# Spec: Notification click focuses VS Code + Pi terminal

## Goal
When the macOS notification is clicked, bring the correct VS Code window to the foreground and focus the terminal that hosts the Pi instance that fired the notification.

## Assumptions
- VS Code extension can map a Pi instance to a specific terminal by matching the terminal's `processId` against Pi's ancestor PID chain.
- Pi extension can include that ancestor PID chain in the notification payload (or in the socket query backing the notification).

## Options

### Option A: `terminal-notifier` with URL callback (recommended)
- Use `terminal-notifier` to send the notification with a callback URL containing an identifier.
- On click, `terminal-notifier` opens a custom URI that the VS Code extension registers via `vscode://` scheme.
- Example:
  - Notification payload includes: `-open "vscode://pi-terminal-notify/focus?pid=123&ancestors=123,456,1"`
  - VS Code extension registers a command handler for URI activation.

### Option B: AppleScript polling
- Notification uses AppleScript `display notification` (no click callback).
- Cannot directly handle click; would require polling or additional UI hooks.
- Not recommended.

## Implementation Plan (Option A)

### 1) Add dependency on `terminal-notifier`
- Ensure `terminal-notifier` is installed (brew install terminal-notifier).
- Pi extension detects its presence and falls back to `osascript` if missing.

### 2) Pi extension sends notification with callback
- Include payload with ancestor PID chain (cap: 15):
  - `terminal-notifier -title "Pi" -message "Pi is waiting for input" -open "vscode://pi-terminal-notify/focus?ancestors=123,456,1"`
- Include unique `-group` to collapse notifications per Pi terminal (e.g., based on `process.pid`).

### 3) VS Code extension registers URI handler
- Add `activationEvents`: `onUri`.
- Register `vscode.window.registerUriHandler`.
- On URI:
  - Parse `ancestors` query param into a number list.
  - Find a terminal whose `processId` matches any ancestor PID.
  - Focus VS Code window (implicit on URI open).
  - Focus that terminal (`terminal.show(true)`).

### 4) Terminal identification
- Use ancestor PID matching between Pi's process tree and terminal `processId`.
- If multiple terminals match (rare), prefer the active terminal or first match.

### 5) UX / fallback
- If `terminal-notifier` not installed, fall back to normal notification (no click action).
- If terminal not found, show a toast in VS Code and do nothing else.

## Acceptance Criteria
- Clicking the notification brings VS Code to front.
- The correct Pi terminal becomes active.
- Works with multiple Pi instances and windows.
- Safe fallback when `terminal-notifier` is missing.
