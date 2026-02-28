import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Bridge, type BridgeOptions } from './bridge.js';
import { TerminalSession } from './terminal.js';
import path from 'node:path';
import { homedir } from 'node:os';
import { getRecentSessions, recordSession, renameSession } from './sessions.js';

export interface ServerOptions {
  port: number;                    // default 3000
  staticDir?: string;             // directory to serve static files from
  copilotCommand?: string;        // default: process.env.COPILOT_COMMAND || 'copilot'
  copilotArgs?: string[];         // default: ['--acp', '--stdio']
  cwd?: string;                   // working directory for copilot
}

export interface ServerResult {
  server: ReturnType<typeof createServer>;
  sessionToken: string;
  close: () => void;
}

/** A single chat session slot with its own bridge and cwd. */
interface SessionSlot {
  id: string;
  cwd: string;
  bridge: Bridge;
  socket: WebSocket | null;
  pendingSessionNewIds: Set<number | string>;
}

/**
 * Discover plugin skills directories so copilot in ACP mode can find them.
 * Copilot CLI doesn't load installed-plugin skills in --acp mode unless
 * COPILOT_SKILLS_DIRS is set.
 */
function discoverPluginSkillsDirs(): string | undefined {
  const pluginsRoot = path.join(
    process.env.XDG_CONFIG_HOME ?? homedir(),
    process.env.XDG_CONFIG_HOME ? 'installed-plugins' : '.copilot/installed-plugins',
  );

  if (!existsSync(pluginsRoot)) return undefined;

  const dirs: string[] = [];
  try {
    // Walk two levels: marketplace/plugin/skills or _direct/plugin/skills
    for (const marketplace of readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      const mpPath = path.join(pluginsRoot, marketplace.name);
      for (const plugin of readdirSync(mpPath, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const skillsDir = path.join(mpPath, plugin.name, 'skills');
        if (existsSync(skillsDir)) dirs.push(skillsDir);
      }
    }
  } catch {
    // ignore permission errors
  }

  return dirs.length > 0 ? dirs.join(',') : undefined;
}

const SHELL_TIMEOUT_MS = 30_000;

function handleShellCommand(
  ws: WebSocket,
  id: number | string | undefined,
  command: string | undefined,
  cwd: string,
): void {
  if (id === undefined || !command) {
    if (id !== undefined) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing command parameter' },
      }));
    }
    return;
  }

  exec(command, { cwd, timeout: SHELL_TIMEOUT_MS }, (err, stdout, stderr) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    if (err && (err as any).killed) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -1, message: 'Command timed out' },
      }));
      return;
    }

    const exitCode = err ? (err.code ?? 1) : 0;
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: { stdout, stderr, exitCode },
    }));
  });
}

export function startServer(options: ServerOptions): ServerResult {
  const app = express();
  const port = options.port || 3000;
  const sessionToken = randomBytes(32).toString('hex');

  const resolvedCwd = options.cwd || process.cwd();

  // Token endpoint (must be before SPA fallback)
  app.get('/api/token', (_req, res) => {
    res.json({ token: sessionToken, cwd: resolvedCwd });
  });

  // Sessions endpoint
  app.get('/api/sessions', async (req, res) => {
    const cwd = req.query.cwd as string | undefined;
    if (!cwd) {
      res.status(400).json({ error: 'Missing required query parameter: cwd' });
      return;
    }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const sessions = await getRecentSessions(cwd, limit);
    res.json({ sessions });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });

  // Route upgrade requests to the correct WebSocket server
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url!, `http://localhost`).pathname;
    if (pathname === '/ws/terminal') {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // ─── Multi-session management ──────────────────────────────────────
  const sessionSlots = new Map<string, SessionSlot>();
  let activeTerminal: TerminalSession | null = null;

  /** Determine command and args for bridge spawning. */
  function getBridgeCommand(): { command: string; args: string[] } {
    const envCommand = !options.copilotCommand ? process.env.COPILOT_COMMAND : undefined;
    if (envCommand) {
      const parts = envCommand.split(' ');
      return { command: parts[0], args: parts.slice(1) };
    }
    return {
      command: options.copilotCommand ?? 'copilot',
      args: options.copilotArgs ?? ['--acp', '--stdio'],
    };
  }

  /** Build bridge env with plugin skills discovery. */
  function getBridgeEnv(): Record<string, string | undefined> | undefined {
    const bridgeEnv: Record<string, string | undefined> = {};
    const skillsDirs = process.env.COPILOT_SKILLS_DIRS ?? discoverPluginSkillsDirs();
    if (skillsDirs) {
      bridgeEnv.COPILOT_SKILLS_DIRS = skillsDirs;
    }
    return Object.keys(bridgeEnv).length > 0 ? bridgeEnv : undefined;
  }

  /** Create a new session slot with its own bridge in the given cwd. */
  function createSessionSlot(cwd: string): SessionSlot {
    const id = randomBytes(8).toString('hex');
    const { command, args } = getBridgeCommand();
    const bridgeOptions: BridgeOptions = { command, args, cwd, env: getBridgeEnv() };

    console.log(`Creating session ${id} in ${cwd} (${command} ${args.join(' ')})`);

    const bridge = new Bridge(bridgeOptions);
    const slot: SessionSlot = {
      id,
      cwd,
      bridge,
      socket: null,
      pendingSessionNewIds: new Set(),
    };

    sessionSlots.set(id, slot);
    return slot;
  }

  /** Kill and remove a session slot. */
  function destroySessionSlot(slotId: string): void {
    const slot = sessionSlots.get(slotId);
    if (!slot) return;
    slot.bridge.kill();
    if (slot.socket && slot.socket.readyState === WebSocket.OPEN) {
      slot.socket.close(1000, 'Session destroyed');
    }
    sessionSlots.delete(slotId);
    console.log(`Session ${slotId} destroyed`);
  }

  // ─── Session management endpoints ──────────────────────────────────
  app.use(express.json());

  app.post('/api/sessions/create', (req, res) => {
    const cwd = req.body?.cwd;
    if (!cwd || typeof cwd !== 'string') {
      res.status(400).json({ error: 'Missing required field: cwd' });
      return;
    }
    const resolved = path.resolve(cwd);
    if (!existsSync(resolved)) {
      res.status(400).json({ error: `Directory does not exist: ${resolved}` });
      return;
    }
    const slot = createSessionSlot(resolved);
    res.json({ slotId: slot.id, cwd: slot.cwd });
  });

  app.get('/api/sessions/active', (_req, res) => {
    const active = Array.from(sessionSlots.values()).map(s => ({
      slotId: s.id,
      cwd: s.cwd,
      connected: s.socket !== null && s.socket.readyState === WebSocket.OPEN,
    }));
    res.json({ sessions: active });
  });

  app.delete('/api/sessions/active/:slotId', (req, res) => {
    const { slotId } = req.params;
    if (!sessionSlots.has(slotId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    destroySessionSlot(slotId);
    res.json({ ok: true });
  });

  // Endpoint to get terminal cwd
  app.get('/api/terminal/cwd', (_req, res) => {
    if (!activeTerminal) {
      res.status(404).json({ error: 'No active terminal' });
      return;
    }
    const pid = activeTerminal.pid;
    if (!pid) {
      res.status(500).json({ error: 'Cannot determine terminal PID' });
      return;
    }
    // Use lsof to get the cwd of the shell process (macOS)
    exec(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null | grep '^n' | head -1 | sed 's/^n//'`, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        // Fallback: try /proc on Linux
        exec(`readlink -f /proc/${pid}/cwd 2>/dev/null`, { timeout: 5000 }, (err2, stdout2) => {
          if (err2 || !stdout2.trim()) {
            res.json({ cwd: resolvedCwd }); // fallback to server cwd
          } else {
            res.json({ cwd: stdout2.trim() });
          }
        });
        return;
      }
      const cwd = stdout.trim().replace(/^n/, '');
      res.json({ cwd: cwd || resolvedCwd });
    });
  });

  // Serve static files if configured (must be after all API routes)
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    // SPA fallback: serve index.html for unknown routes
    app.get('*', (req, res) => {
      if (options.staticDir) {
        res.sendFile(path.join(options.staticDir, 'index.html'));
      } else {
        res.status(404).send('Not found');
      }
    });
  }

  wss.on('connection', (ws, request) => {
    // Validate session token
    const url = new URL(request.url!, `http://localhost`);
    const token = url.searchParams.get('token');
    if (token !== sessionToken) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Determine which session slot to connect to
    const slotId = url.searchParams.get('slotId');
    let slot: SessionSlot;

    if (slotId && sessionSlots.has(slotId)) {
      slot = sessionSlots.get(slotId)!;
      // Close existing socket for this slot if any
      if (slot.socket && slot.socket.readyState === WebSocket.OPEN) {
        slot.socket.close(1000, 'Replaced by new connection');
      }
    } else if (!slotId) {
      // No slotId — create a default session (backwards compatible)
      slot = createSessionSlot(resolvedCwd);
    } else {
      ws.close(4004, 'Session slot not found');
      return;
    }

    console.log(`Client connected to session ${slot.id} (${slot.cwd})`);
    slot.socket = ws;

    // Keepalive ping every 15s to prevent idle timeout (mobile, tunnels)
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 15_000);

    // If the bridge died, create a fresh one for this slot
    if (!slot.bridge.isAlive()) {
      const { command, args } = getBridgeCommand();
      const bridgeOptions: BridgeOptions = { command, args, cwd: slot.cwd, env: getBridgeEnv() };
      slot.bridge = new Bridge(bridgeOptions);
      console.log(`Respawned bridge for session ${slot.id}`);
    }

    const bridge = slot.bridge;

    try {
      bridge.spawn();
    } catch (err) {
      // spawn() throws if already spawned — that's fine (existing live bridge)
      if (!bridge.isAlive()) {
        console.error('Failed to spawn bridge:', err);
        ws.close(1011, 'Failed to spawn bridge');
        clearInterval(pingInterval);
        destroySessionSlot(slot.id);
        return;
      }
    }

    // Bridge -> WebSocket (intercept session/new responses)
    bridge.onMessage((line) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // Check if this is a response to a session/new request
      if (slot.pendingSessionNewIds.size > 0) {
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && slot.pendingSessionNewIds.has(msg.id) && msg.result?.sessionId) {
            slot.pendingSessionNewIds.delete(msg.id);
            recordSession(slot.cwd, msg.result.sessionId);
          }
        } catch {
          // Not valid JSON — ignore
        }
      }

      ws.send(line);
    });

    bridge.onError((err) => {
      console.error(`Bridge error (session ${slot.id}):`, err);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Bridge error');
      }
    });

    bridge.onClose((code) => {
      console.log(`Bridge closed with code ${code} (session ${slot.id})`);
      if (ws.readyState === WebSocket.OPEN) {
        // Use 4100 (custom) so client knows bridge died (not a clean close)
        ws.close(4100, 'Bridge closed');
      }
    });

    // WebSocket -> Bridge (with uplink-specific message interception)
    ws.on('message', (message) => {
      const raw = message.toString();
      let parsed: { jsonrpc?: string; id?: number | string; method?: string; params?: { command?: string; model?: string; sessionId?: string; summary?: string } } | undefined;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not valid JSON — forward as-is
      }

      if (parsed?.method === 'uplink/shell') {
        handleShellCommand(ws, parsed.id, parsed.params?.command, slot.cwd);
        return;
      }

      if (parsed?.method === 'uplink/rename_session') {
        const { sessionId, summary } = parsed.params ?? {};
        if (parsed.id !== undefined && sessionId && summary) {
          renameSession(sessionId, summary);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        } else if (parsed.id !== undefined) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32602, message: 'Missing sessionId or summary' } }));
        }
        return;
      }

      // Track session/new requests to capture the session ID from the response
      if (parsed?.method === 'session/new' && parsed.id != null) {
        slot.pendingSessionNewIds.add(parsed.id);
      }

      bridge.send(raw);
    });

    ws.on('close', () => {
      console.log(`Client disconnected from session ${slot.id}`);
      clearInterval(pingInterval);
      if (slot.socket === ws) {
        slot.socket = null;
      }
      // Don't destroy the slot on disconnect — allow reconnecting
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  });

  // ─── Terminal WebSocket ────────────────────────────────────────────
  terminalWss.on('connection', (ws, request) => {
    const url = new URL(request.url!, `http://localhost`);
    const token = url.searchParams.get('token');
    if (token !== sessionToken) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Kill any existing terminal session
    if (activeTerminal) {
      activeTerminal.kill();
      activeTerminal = null;
    }

    console.log('Terminal client connected');

    let terminal: TerminalSession;
    try {
      terminal = new TerminalSession({ cwd: resolvedCwd });
    } catch (err) {
      console.error('Failed to spawn terminal:', err);
      ws.close(1011, 'Failed to spawn terminal');
      return;
    }
    activeTerminal = terminal;

    // Keepalive ping every 15s to prevent idle timeout (mobile, tunnels)
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 15_000);

    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    terminal.onExit((code) => {
      console.log(`Terminal exited with code ${code}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code }));
        ws.close(1000, 'Terminal exited');
      }
      if (activeTerminal === terminal) {
        activeTerminal = null;
      }
    });

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'data' && typeof msg.data === 'string') {
          terminal.write(msg.data);
        } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          terminal.resize(msg.cols, msg.rows);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      console.log('Terminal client disconnected');
      clearInterval(pingInterval);
      terminal.kill();
      if (activeTerminal === terminal) {
        activeTerminal = null;
      }
    });
  });

  const close = () => {
    if (activeTerminal) {
      activeTerminal.kill();
      activeTerminal = null;
    }

    for (const [id] of sessionSlots) {
      destroySessionSlot(id);
    }

    for (const client of wss.clients) {
      if (
        client.readyState === WebSocket.OPEN ||
        client.readyState === WebSocket.CONNECTING
      ) {
        client.close(1001, 'Server shutting down');
      }
    }
  };

  return { server, sessionToken, close };
}

