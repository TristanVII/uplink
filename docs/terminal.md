# Interactive Terminal

The interactive terminal adds a full PTY-backed shell to Copilot Uplink, accessible from the same browser tab as the chat interface.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (PWA)                                      │
│  ┌──────────┐  ┌──────────────────────────────────┐ │
│  │ Chat Tab │  │ Terminal Tab                     │ │
│  │ (ACP)    │  │ xterm.js ↔ WebSocket            │ │
│  └────┬─────┘  └──────────────┬───────────────────┘ │
│       │                       │                     │
└───────┼───────────────────────┼─────────────────────┘
        │                       │
   /ws (ACP)            /ws/terminal
        │                       │
┌───────┼───────────────────────┼─────────────────────┐
│  Bridge Server (Node.js)      │                     │
│       │                       │                     │
│  ┌────┴─────┐          ┌──────┴───────┐             │
│  │ Bridge   │          │ Terminal     │             │
│  │ (stdio)  │          │ Session     │             │
│  └────┬─────┘          │ (node-pty)  │             │
│       │                └──────┬───────┘             │
│  copilot --acp          /bin/bash (or $SHELL)       │
└─────────────────────────────────────────────────────┘
```

The chat and terminal are fully independent:

- **Chat** uses `/ws` and speaks JSON-RPC (ACP protocol) to the Copilot CLI subprocess
- **Terminal** uses `/ws/terminal` and streams raw PTY data via JSON messages to a shell process

Both WebSocket endpoints share the same HTTP server and devtunnel URL. A manual `upgrade` handler routes connections by pathname.

## Components

### Server

**`src/server/terminal.ts`** — `TerminalSession` class

- Wraps `node-pty` to spawn a shell (`$SHELL` or `/bin/bash`)
- Exposes `write()`, `resize()`, `kill()`, and event callbacks (`onData`, `onExit`)
- One session per WebSocket connection; cleaned up on disconnect

**`src/server/index.ts`** — WebSocket routing

- Uses `noServer` mode for both `WebSocketServer` instances to avoid conflicts
- The HTTP server's `upgrade` event is handled manually:
  - `/ws` → ACP bridge (existing)
  - `/ws/terminal` → terminal session (new)
- Both endpoints validate the session token from the query string

**`src/server/index.ts`** — WebSocket keepalive

- Pings the terminal WebSocket every 15 seconds to prevent idle timeout
- Mobile browsers and tunnel proxies aggressively close idle connections; the ping keeps them alive
- Ping interval is cleaned up on disconnect

### Client

**`src/client/ui/terminal.tsx`** — `TerminalPanel` Preact component

- Renders an `xterm.js` terminal with `FitAddon` for auto-sizing
- `ClipboardAddon` for improved clipboard integration
- Catppuccin Mocha (dark) and Latte (light) themes, synced with the app theme
- Connects to `/ws/terminal` and exchanges JSON messages
- `ResizeObserver` triggers fit + sends resize to server
- **Auto-reconnect** — if the WebSocket drops unexpectedly, the client waits 2 seconds then reconnects and spawns a new shell. Status messages (`[Reconnecting...]`, `[Reconnected]`) are shown inline.

**`src/client/main.ts`** — Tab switching

- Tab bar with Chat and Terminal buttons
- Switching tabs shows/hides the panels and triggers terminal refit
- Terminal WebSocket URL is set after fetching the session token

### Mobile Controls

On screens ≤ 600px wide, a sidebar appears on the right side of the terminal with touch-friendly buttons:

| Button | Icon | Action |
|---|---|---|
| **Select** | `select_all` / `terminal` | Toggles **select mode** — replaces the canvas with a plain `<pre>` element containing the terminal buffer text. This enables native mobile text selection (long-press → drag handles → copy). Tap again to return to the interactive terminal. |
| **↑** | `keyboard_arrow_up` | Sends arrow-up to the shell (history previous) |
| **↓** | `keyboard_arrow_down` | Sends arrow-down to the shell (history next) |

**Why select mode?** xterm.js renders to a `<canvas>` element, which does not support native mobile text selection (the long-press → drag handles flow that works on regular DOM text). Select mode works around this by extracting the terminal buffer via xterm's buffer API (`getLine()` / `translateToString()`) and displaying it as selectable plain text.

### Wire Protocol

The terminal WebSocket uses simple JSON text messages:

| Direction | Message | Fields |
|---|---|---|
| Client → Server | Input | `{ "type": "data", "data": "<keystrokes>" }` |
| Client → Server | Resize | `{ "type": "resize", "cols": 80, "rows": 24 }` |
| Server → Client | Output | `{ "type": "data", "data": "<terminal output>" }` |
| Server → Client | Exit | `{ "type": "exit", "code": 0 }` |

## Prerequisites

`node-pty` is a native Node.js addon. You need:

- **Node.js ≥ 22.14.0** (as specified in `package.json` engines)
- **Python 3** and a **C++ compiler** (for building the native module)
  - macOS: `xcode-select --install`
  - Linux: `sudo apt install build-essential python3`
  - Windows: `npm install --global windows-build-tools`

## Testing Locally

### 1. Install and build

```bash
cd uplink
npm install
npm run build
```

### 2. Start with the mock agent (no Copilot CLI needed)

```bash
COPILOT_COMMAND="npx tsx src/mock/mock-agent.ts --acp --stdio" node dist/bin/cli.js
```

Open `http://localhost:3000` in a browser. You should see:

- A **tab bar** with "Chat" and "Terminal" tabs
- Click **Terminal** — a full interactive shell appears
- Try running commands: `ls`, `pwd`, `top`, `vim` (all interactive)
- Switch back to **Chat** to talk to the mock agent

### 3. Start with the real Copilot CLI

```bash
npx @mattkotsenas/uplink@latest
# or with remote access:
npx @mattkotsenas/uplink@latest --tunnel
```

### 4. Test with the dev server (hot reload)

Run the bridge server in one terminal:

```bash
COPILOT_COMMAND="npx tsx src/mock/mock-agent.ts --acp --stdio" node dist/bin/cli.js
```

Run Vite dev server in another:

```bash
npm run dev
```

Open `http://localhost:5173`. The Vite proxy forwards both `/ws` and `/ws/terminal` to the bridge server on port 3000.

### 5. Run the test suite

```bash
# Unit + integration tests
npm test

# CSS lint
npm run lint:css

# Full validation (lint + build + test + e2e)
npm run test:all
```

All 164 existing tests continue to pass — the terminal feature is additive and doesn't modify any existing ACP logic.

## Connection Resilience

### Keepalive

The server sends a WebSocket **ping frame every 15 seconds** on the terminal connection. This prevents:

- Mobile browsers from closing idle connections (iOS Safari, Android Chrome)
- Tunnel proxies (devtunnel) from timing out inactive WebSockets
- Corporate firewalls/NATs from dropping idle TCP connections

### Auto-Reconnect

If the terminal WebSocket closes unexpectedly (network blip, phone sleep/wake, tunnel restart), the client automatically:

1. Shows `[Terminal disconnected]` and `[Reconnecting...]` in the terminal
2. Waits 2 seconds
3. Opens a new WebSocket connection
4. Spawns a fresh shell session on the server
5. Shows `[Reconnected]` on success

Clean closes (code 1000, e.g. user navigated away) do **not** trigger reconnect. Note that the previous shell session and its state are lost on reconnect — this is a new PTY process.

## Inline Shell Commands

The `!command` syntax in the chat input still works for quick one-shot commands:

```
!ls -la
!git status
```

These use the original `uplink/shell` JSON-RPC method (30s timeout, non-interactive). The terminal tab is for interactive, persistent shell sessions.

## Limitations

- **Single terminal session** — one shell per connection (matches the single-client constraint)
- **No session persistence** — terminal state (shell history, running processes) is lost on reconnect; a new shell is spawned
- **Native dependency** — `node-pty` requires build tools at install time
- **No terminal multiplexing** — one shell, no tabs/splits within the terminal
- **Select mode is read-only** — you cannot type while in select mode; toggle back to the terminal first
