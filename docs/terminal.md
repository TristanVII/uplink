# Interactive Terminal

The interactive terminal adds a full PTY-backed shell to Copilot Uplink, accessible from the same browser tab as the chat interface.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Browser (PWA)                                                │
│                                                               │
│  ┌─ Tab Bar ────────────────────────────────────────────────┐ │
│  │ [Terminal]  [● 📁 myapp ✕]  [◉ 📁 api ✕]  [○ 📁 lib ✕] │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌──────────────┐  ┌───────────────────────────────────────┐  │
│  │ Terminal Tab  │  │ Chat Panel (per session)              │  │
│  │ xterm.js     │  │ AcpClient ↔ Conversation ↔ ChatList  │  │
│  │ [Start Chat] │  │ Input area + command palette          │  │
│  └──────┬───────┘  └──────────────┬────────────────────────┘  │
│         │                         │                           │
└─────────┼─────────────────────────┼───────────────────────────┘
          │                         │
     /ws/terminal          /ws?slotId=<id>
          │                         │
┌─────────┼─────────────────────────┼───────────────────────────┐
│  Bridge Server (Node.js)          │                           │
│         │              ┌──────────┴──────────┐                │
│  ┌──────┴───────┐      │ SessionSlot Map     │                │
│  │ Terminal     │      │ ┌─────────────────┐ │                │
│  │ Session      │      │ │ slot-a: Bridge  │ │                │
│  │ (node-pty)   │      │ │ slot-b: Bridge  │ │                │
│  └──────┬───────┘      │ │ slot-c: Bridge  │ │                │
│         │              │ └────────┬────────┘ │                │
│  /bin/zsh ($SHELL)     └──────────┼──────────┘                │
│                           copilot --acp --stdio (per slot)    │
└───────────────────────────────────────────────────────────────┘
```

The terminal and chat sessions are fully independent:

- **Terminal** uses `/ws/terminal` and streams raw PTY data via JSON messages to a single shared shell process
- **Chat sessions** (up to 4) each use `/ws?slotId=<id>` and speak JSON-RPC (ACP protocol) to their own Copilot CLI subprocess, scoped to a specific working directory
- On startup, only the terminal tab is shown — no chat sessions are created until the user requests one

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

- Pings **both** terminal and chat WebSockets every 15 seconds to prevent idle timeout
- Mobile browsers and tunnel proxies aggressively close idle connections; the ping keeps them alive
- Ping intervals are cleaned up on disconnect

**`src/server/index.ts`** — Session slot management

- `SessionSlot` Map holds per-session state: `{ id, cwd, bridge, socket, pendingSessionNewIds }`
- `createSessionSlot(cwd)` spawns a new Bridge subprocess in the given directory
- `destroySessionSlot(id)` kills the bridge and closes the WebSocket
- If a bridge dies, it is automatically **respawned** when a client reconnects to that slot
- REST endpoints for session lifecycle (see [Server Endpoints](#server-endpoints))

### Client

**`src/client/ui/terminal.tsx`** — `TerminalPanel` Preact component

- Renders an `xterm.js` terminal with `FitAddon` for auto-sizing
- `ClipboardAddon` for improved clipboard integration
- Catppuccin Mocha (dark) and Latte (light) themes, synced with the app theme
- Connects to `/ws/terminal` and exchanges JSON messages
- `ResizeObserver` triggers fit + sends resize to server
- **Auto-reconnect** — if the WebSocket drops unexpectedly, the client waits 2 seconds then reconnects and spawns a new shell. Status messages (`[Reconnecting...]`, `[Reconnected]`) are shown inline.

**`src/client/main.ts`** — Multi-tab session orchestrator

- Manages a `Map<string, ChatSession>` of up to 4 simultaneous chat sessions
- Each `ChatSession` has its own `AcpClient`, `Conversation`, and DOM panel
- `createChatPanel()` — DOM factory that builds a complete chat panel (messages area, input, buttons, command palette) using class-based selectors so multiple instances coexist
- `switchTab()` — hides all panels, shows the selected one, updates header status
- `handleStartChatHere()` — fetches terminal cwd via `/api/terminal/cwd`, creates a session scoped to that directory
- On startup, only the terminal tab is shown — no chat sessions until the user creates one

**Tab status indicators** — each chat tab has a colored dot showing session state:

| Dot | State | Meaning |
|---|---|---|
| ⚪ Grey | `ready` | Idle, waiting for input |
| 🟢 Pulsing green | `prompting` | Actively running a prompt |
| 🟡 Pulsing yellow | `connecting` / `initializing` | Establishing connection |
| 🔴 Red | `disconnected` | Connection lost |

Status updates apply to **all** tabs, not just the active one — you can see background sessions working while you're on another tab.

- Terminal WebSocket URL is set after fetching the session token

### Controls Sidebar

A sidebar appears on the right side of the terminal with action buttons. The "Start Chat Here" button is always visible; other controls appear on mobile (≤ 600px):

| Button | Icon | Visibility | Action |
|---|---|---|---|
| **Start Chat** | `add_comment` | Always | Creates a new chat session scoped to the terminal's current directory |
| **Select** | `select_all` / `terminal` | Mobile | Toggles **select mode** — replaces the canvas with a plain `<pre>` element containing the terminal buffer text. This enables native mobile text selection (long-press → drag handles → copy). Tap again to return to the interactive terminal. |
| **↑** | `keyboard_arrow_up` | Always | Sends arrow-up to the shell (history previous) |
| **↓** | `keyboard_arrow_down` | Always | Sends arrow-down to the shell (history next) |

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

- A **tab bar** with only the "Terminal" tab
- A full interactive shell in the terminal
- The **"Start Chat Here" button** in the terminal sidebar
- Click it — a new chat tab appears scoped to the current directory
- Switch back to **Terminal** to navigate to another directory and create more tabs

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

The server sends a WebSocket **ping frame every 15 seconds** on **both** terminal and chat connections. This prevents:

- Mobile browsers from closing idle connections (iOS Safari, Android Chrome)
- Tunnel proxies (devtunnel) from timing out inactive WebSockets
- Corporate firewalls/NATs from dropping idle TCP connections

### Terminal Auto-Reconnect

If the terminal WebSocket closes unexpectedly (network blip, phone sleep/wake, tunnel restart), the client automatically:

1. Shows `[Terminal disconnected]` and `[Reconnecting...]` in the terminal
2. Waits 2 seconds
3. Opens a new WebSocket connection
4. Spawns a fresh shell session on the server
5. Shows `[Reconnected]` on success

Clean closes (code 1000, e.g. user navigated away) do **not** trigger reconnect. Note that the previous shell session and its state are lost on reconnect — this is a new PTY process.

### Chat Auto-Reconnect

The `AcpClient` has built-in reconnect with exponential backoff. If a chat WebSocket drops:

1. The tab status dot turns red (disconnected)
2. The client schedules a reconnect with exponential backoff (starting at 1s, max 30s)
3. On reconnect, the server **respawns the bridge** if it died (custom close code `4100` distinguishes bridge death from clean closes)
4. A new `session/new` is created with the same working directory
5. The tab status dot returns to grey (idle)

The session slot is preserved on the server even when the client disconnects — the bridge stays alive for reconnection. If the bridge itself crashes, it is respawned automatically when the client reconnects.

## Multi-Chat Tabs

You can run up to **4 simultaneous chat sessions**, each scoped to a different working directory. The terminal stays shared and independent.

### How It Works

1. **Start with the terminal** — on launch, only the Terminal tab is shown
2. **Navigate** to any project directory (`cd ~/projects/my-app`)
3. **Tap "Start Chat Here"** (`add_comment` icon) in the terminal sidebar
4. A new chat tab appears: `● 📁 my-app ✕` — scoped to that directory
5. **Repeat** for other directories (up to 4 tabs total)
6. **Close** a chat tab by clicking the `✕` button on its tab

### Tab Indicators

Each chat tab shows a status dot (see [Tab status indicators](#tab-status-indicators) above) so you can monitor background sessions at a glance.

### Switching Between Tabs

- **Click any tab** in the tab bar to switch
- The Terminal tab is always available as the first tab
- Chat tabs show `📁 foldername` with the full path as a tooltip

### Architecture

Each session has its own:
- **Bridge subprocess** — a separate `copilot --acp --stdio` process running in the session's cwd
- **Conversation** — independent message history and tool calls
- **WebSocket connection** — connected to a server-side session slot

The terminal is shared across all sessions — it's a single shell that you use to navigate directories and create new sessions.

### Server Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/sessions/create` | Create a new session slot (`{ cwd }`) |
| `GET` | `/api/sessions/active` | List all active session slots |
| `DELETE` | `/api/sessions/active/:slotId` | Destroy a session slot |
| `GET` | `/api/terminal/cwd` | Get the terminal shell's current working directory |

### Wire Protocol

WebSocket connections accept an optional `?slotId=` query parameter to connect to a specific session. If omitted, a new default session is created (backwards compatible).

## Inline Shell Commands

The `!command` syntax in the chat input still works for quick one-shot commands:

```
!ls -la
!git status
```

These use the original `uplink/shell` JSON-RPC method (30s timeout, non-interactive). The terminal tab is for interactive, persistent shell sessions.

## Limitations

- **Max 4 chat tabs** — enforced client-side; attempting to create more shows a console warning
- **Single terminal session** — one shared shell per connection
- **No session persistence** — terminal state (shell history, running processes) is lost on reconnect; a new shell is spawned
- **Chat session state on reconnect** — if a bridge dies and is respawned, a new ACP session is created (conversation history in the UI is preserved but the server-side context resets)
- **Native dependency** — `node-pty` requires build tools at install time
- **No terminal multiplexing** — one shell, no tabs/splits within the terminal
- **Select mode is read-only** — you cannot type while in select mode; toggle back to the terminal first
- **Terminal cwd detection** — uses `lsof` on macOS and `/proc` on Linux; may not work in all environments
