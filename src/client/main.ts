import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList } from './ui/chat.js';
import { TerminalPanel } from './ui/terminal.js';
import { showPermissionRequest, cancelAllPermissions } from './ui/permission.js';
import { fetchSessions, openSessionsModal, SessionsModal } from './ui/sessions.js';
import { CommandPalette, type PaletteItem } from './ui/command-palette.js';
import { getCompletions, parseSlashCommand, setAvailableModels, findModelName } from './slash-commands.js';
import { render, h } from 'preact';
import 'material-symbols/outlined.css';

// ─── DOM References ───────────────────────────────────────────────────

const chatArea = document.getElementById('chat-area')!;
const terminalArea = document.getElementById('terminal-area')!;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const modelLabel = document.getElementById('model-label')!;
const tabButtons = document.querySelectorAll<HTMLButtonElement>('#tab-bar .tab');

let yoloMode = localStorage.getItem('uplink-yolo') === 'true';

// ─── Tab Switching ────────────────────────────────────────────────────

let activeTab: 'chat' | 'terminal' = 'chat';

function switchTab(tab: 'chat' | 'terminal'): void {
  activeTab = tab;
  tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  chatArea.hidden = tab !== 'chat';
  document.getElementById('input-area')!.hidden = tab !== 'chat';
  terminalArea.hidden = tab !== 'terminal';
  renderTerminal();
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab as 'chat' | 'terminal'));
});

// ─── Mode ─────────────────────────────────────────────────────────────

type AgentMode = 'chat' | 'plan' | 'autopilot';
let currentMode: AgentMode = 'chat';

function applyMode(mode: AgentMode): void {
  currentMode = mode;
  document.documentElement.setAttribute('data-mode', mode);
}

applyMode(currentMode);

// ─── Theme ────────────────────────────────────────────────────────────

function applyTheme(theme: string): void {
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.className = prefersDark ? 'dark' : 'light';
  } else {
    document.documentElement.className = theme;
  }
  localStorage.setItem('uplink-theme', theme);
}

function initTheme(): void {
  const saved = localStorage.getItem('uplink-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved ?? (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

initTheme();

// ─── Service Worker ───────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// ─── UI Components ────────────────────────────────────────────────────

// ─── Multi-Session State ──────────────────────────────────────────────

interface ChatSession {
  slotId: string;
  cwd: string;
  client: AcpClient;
  conversation: Conversation;
}

const sessions = new Map<string, ChatSession>();
let activeSessionId: string | null = null;

function getActiveSession(): ChatSession | null {
  return activeSessionId ? sessions.get(activeSessionId) ?? null : null;
}

// Mount all timeline components into a single chatContainer.
// ChatList renders messages, and child components (tool calls, permissions,
// plans) are passed as children so they appear inline in the message flow.
const chatContainer = document.createElement('div');
chatContainer.className = 'chat-container chat-messages';
chatArea.appendChild(chatContainer);

function renderChat(): void {
  const session = getActiveSession();
  if (session) {
    render(
      h(ChatList, { conversation: session.conversation, scrollContainer: chatArea }),
      chatContainer,
    );
  }
}

// Mount Preact sessions modal on body
const sessionsModalContainer = document.createElement('div');
document.body.appendChild(sessionsModalContainer);
render(h(SessionsModal, {}), sessionsModalContainer);

// Mount terminal panel
let terminalWsUrl = '';
function renderTerminal(): void {
  render(
    h(TerminalPanel, {
      wsUrl: terminalWsUrl,
      visible: activeTab === 'terminal',
      onStartChatHere: handleStartChatHere,
    }),
    terminalArea,
  );
}

/** Clear all conversation state when session changes. */
function clearConversation(): void {
  const session = getActiveSession();
  if (session) {
    session.conversation.clear();
    cancelAllPermissions(session.conversation);
  }
}

// ─── WebSocket / ACP Client ──────────────────────────────────────────

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

let sessionToken: string = '';
let serverCwd: string = '';

function updateConnectionStatus(state: ConnectionState): void {
  const el = document.getElementById('connection-status')!;
  // Show "ready" instead of "prompting" since we have the dots indicator
  const displayState = state === 'prompting' ? 'ready' : state;
  el.textContent = displayState;
  el.className = `status-${
    state === 'ready' || state === 'prompting'
      ? 'connected'
      : state === 'connecting' || state === 'initializing'
        ? 'reconnecting'
        : 'disconnected'
  }`;

  const session = getActiveSession();
  sendBtn.disabled = state !== 'ready';
  sendBtn.hidden = state === 'prompting';
  cancelBtn.hidden = state !== 'prompting';

  if (session) {
    session.conversation.isPrompting = state === 'prompting';
    session.conversation.notify();
  }
}

/** Create a new AcpClient connected to a specific session slot. */
function createClientForSlot(slotId: string, cwd: string): AcpClient {
  const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(sessionToken)}&slotId=${encodeURIComponent(slotId)}`;

  return new AcpClient({
    wsUrl,
    cwd,
    onStateChange: (state) => {
      // Only update UI status if this is the active session
      if (activeSessionId === slotId) {
        updateConnectionStatus(state);
      }
    },
    onSessionUpdate: (update) => {
      const s = sessions.get(slotId);
      if (s) {
        s.conversation.handleSessionUpdate(update);
        if (activeSessionId === slotId) renderChat();
      }
    },
    onModelsAvailable: (models, currentModelId) => {
      setAvailableModels(models);
      if (currentModelId) {
        const model = models.find((m) => m.modelId === currentModelId);
        modelLabel.textContent = model?.name ?? currentModelId;
      }
    },
    onPermissionRequest: (request, respond) => {
      const s = sessions.get(slotId);
      if (!s) return;
      const autoApproveId = yoloMode
        ? request.options.find(
            (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
          )?.optionId
        : undefined;

      showPermissionRequest(
        s.conversation,
        request.id,
        request.toolCall.toolCallId,
        request.toolCall.title ?? 'Unknown action',
        request.options,
        respond,
        autoApproveId,
      );
    },
    onError: (error) => console.error(`ACP error (session ${slotId}):`, error),
  });
}

/** Create a new session slot on the server and connect a client to it. */
async function createSession(cwd: string): Promise<ChatSession> {
  const res = await fetch('/api/sessions/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  const { slotId, cwd: resolvedCwd } = await res.json();

  const client = createClientForSlot(slotId, resolvedCwd);
  const conversation = new Conversation();
  const session: ChatSession = { slotId, cwd: resolvedCwd, client, conversation };
  sessions.set(slotId, session);

  client.connect().catch(console.error);
  return session;
}

/** Switch the active chat to a different session. */
function switchSession(slotId: string): void {
  const session = sessions.get(slotId);
  if (!session) return;

  activeSessionId = slotId;
  renderChat();
  renderSessionIndicator();

  // Update connection status for the new active session
  updateConnectionStatus(session.client.connectionState);
}

/** Render the active session indicator in the header. */
function renderSessionIndicator(): void {
  const session = getActiveSession();
  let indicator = document.getElementById('session-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.id = 'session-indicator';
    indicator.className = 'session-indicator';
    indicator.addEventListener('click', () => showActiveSessionsModal());
    document.getElementById('header')!.insertBefore(
      indicator,
      document.getElementById('connection-status'),
    );
  }
  if (session) {
    const folderName = session.cwd.split('/').pop() || session.cwd;
    indicator.textContent = `📁 ${folderName}`;
    indicator.title = session.cwd;
  }
}

/** Show the active sessions modal for switching. */
async function showActiveSessionsModal(): Promise<void> {
  const res = await fetch('/api/sessions/active');
  const { sessions: activeSlots } = await res.json() as { sessions: { slotId: string; cwd: string; connected: boolean }[] };

  openSessionsModal(
    activeSlots.map(s => ({
      id: s.slotId,
      summary: s.cwd.split('/').pop() || s.cwd,
      branch: s.cwd,
      updatedAt: new Date().toISOString(),
    })),
    true,
    (slotId) => switchSession(slotId),
    async () => {
      const session = await createSession(serverCwd);
      switchSession(session.slotId);
    },
  );
}

/** Handle "Start Chat Here" from terminal. */
async function handleStartChatHere(): Promise<void> {
  try {
    const res = await fetch('/api/terminal/cwd');
    const { cwd } = await res.json();
    const session = await createSession(cwd);
    switchSession(session.slotId);
    switchTab('chat');
    session.conversation.addSystemMessage(`Session started in ${cwd}`);
  } catch (err) {
    console.error('Failed to start chat:', err);
  }
}

async function initializeClient() {
  const tokenResponse = await fetch('/api/token');
  const { token, cwd } = await tokenResponse.json();
  sessionToken = token;
  serverCwd = cwd;

  terminalWsUrl = `${wsProtocol}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}`;
  renderTerminal();

  // Create the initial default session
  const session = await createSession(cwd);
  switchSession(session.slotId);
  return session.client;
}

// ─── Input Handling ───────────────────────────────────────────────────

sendBtn.addEventListener('click', async () => {
  const text = promptInput.value.trim();
  const session = getActiveSession();
  if (!text || !session) return;

  const { client, conversation } = session;

  promptInput.value = '';
  promptInput.style.height = 'auto';
  hidePalette();
  document.documentElement.setAttribute('data-mode', currentMode);

  // Shell commands: !<command>
  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (!command) return;

    conversation.addUserMessage(`$ ${command}`);

    try {
      const result = await client.sendRawRequest<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>('uplink/shell', { command });
      conversation.addShellResult(command, result.stdout, result.stderr, result.exitCode);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      conversation.addShellResult(command, '', errorMessage, 1);
    }
    return;
  }

  // Slash commands
  let promptText = text;
  const parsed = parseSlashCommand(text);
  if (parsed) {
    if (parsed.kind === 'client') {
      const remainingPrompt = handleClientCommand(parsed.command, parsed.arg);
      if (!remainingPrompt) return;
      // Mode command with a prompt — send the prompt portion
      promptText = remainingPrompt;
    } else if (parsed.command === '/model' && parsed.arg) {
      const name = findModelName(parsed.arg);
      if (name) modelLabel.textContent = name;
    }
  }

  conversation.addUserMessage(text);

  // In plan mode, prefix the message to instruct the agent to plan
  if (currentMode === 'plan' && !text.startsWith('/')) {
    promptText = `/plan ${promptText}`;
  }

  const MAX_AUTOPILOT_TURNS = 25;

  try {
    let stopReason = await client.prompt(promptText);
    // In autopilot mode, auto-continue when the agent ends its turn
    let turns = 0;
    while (currentMode === 'autopilot' && stopReason === 'end_turn' && turns < MAX_AUTOPILOT_TURNS) {
      turns++;
      conversation.addUserMessage('continue');
      stopReason = await client.prompt('continue');
    }
    if (turns >= MAX_AUTOPILOT_TURNS) {
      conversation.addSystemMessage('Autopilot stopped: reached maximum turns');
    }
  } catch (err) {
    console.error('Prompt error:', err);
  }
});

cancelBtn.addEventListener('click', () => {
  const session = getActiveSession();
  if (session) {
    session.client.cancel();
    cancelAllPermissions(session.conversation);
  }
  // Stop autopilot auto-continue loop by switching back to chat mode
  if (currentMode === 'autopilot') {
    applyMode('chat');
    getActiveSession()?.conversation.addSystemMessage('Autopilot cancelled');
  }
});

promptInput.addEventListener('keydown', (e) => {
  // Palette keyboard navigation
  if (paletteVisible) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSelectedIndex = Math.max(0, paletteSelectedIndex - 1);
      renderPalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSelectedIndex = Math.min(paletteItems.length - 1, paletteSelectedIndex + 1);
      renderPalette();
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      if (paletteItems[paletteSelectedIndex]) {
        acceptCompletion(paletteItems[paletteSelectedIndex]);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hidePalette();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

/** Update the input border color to preview the mode implied by the current input text. */
function updateBorderPreview(): void {
  if (promptInput.value.startsWith('!')) {
    document.documentElement.setAttribute('data-mode', 'shell-input');
  } else if (promptInput.value.startsWith('/')) {
    const parts = promptInput.value.slice(1).split(/\s/, 1);
    const cmd = parts[0]?.toLowerCase();
    if (cmd === 'plan' || cmd === 'autopilot') {
      document.documentElement.setAttribute('data-mode', cmd);
    } else if (cmd === 'agent') {
      document.documentElement.setAttribute('data-mode', 'chat');
    } else {
      document.documentElement.setAttribute('data-mode', currentMode);
    }
  } else {
    document.documentElement.setAttribute('data-mode', currentMode);
  }
}

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  const maxH = 150;
  const scrollH = promptInput.scrollHeight;
  promptInput.style.height = Math.min(scrollH, maxH) + 'px';
  promptInput.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';

  // Dynamic border preview based on input prefix
  updateBorderPreview();

  // Show/update command palette when typing /
  if (promptInput.value.startsWith('/')) {
    showPalette();
  } else {
    hidePalette();
  }
});

// ─── Command Palette ──────────────────────────────────────────────────

const paletteMount = document.getElementById('palette-mount')!;
let paletteItems: PaletteItem[] = [];
let paletteSelectedIndex = 0;
let paletteVisible = false;

function renderPalette(): void {
  if (!paletteVisible || paletteItems.length === 0) {
    render(null, paletteMount);
    return;
  }
  render(
    h(CommandPalette, {
      items: paletteItems,
      selectedIndex: paletteSelectedIndex,
      onSelect: (item) => acceptCompletion(item),
      onHover: (i) => { paletteSelectedIndex = i; renderPalette(); },
    }),
    paletteMount,
  );
}

function showPalette(): void {
  const text = promptInput.value;
  paletteItems = getCompletions(text);
  paletteSelectedIndex = 0;
  paletteVisible = paletteItems.length > 0;
  renderPalette();
}

function hidePalette(): void {
  paletteVisible = false;
  renderPalette();
}

function acceptCompletion(item: PaletteItem): void {
  promptInput.value = item.fill;
  promptInput.focus();
  updateBorderPreview();
  if (item.fill.endsWith(' ')) {
    // Top-level command selected — show sub-options or let user type more
    showPalette();
  } else {
    // Concrete sub-option selected — execute
    hidePalette();
    sendBtn.click();
  }
}

// ─── Slash Command Handlers ───────────────────────────────────────────

/** Handle a client-side command. Returns a remaining prompt to send, or undefined. */
function handleClientCommand(command: string, arg: string): string | undefined {
  const session = getActiveSession();
  switch (command) {
    case '/theme':
      applyTheme(arg || 'auto');
      session?.conversation.addSystemMessage(`Theme set to ${arg || 'auto'}`);
      return undefined;
    case '/yolo': {
      const on = arg === '' || arg === 'on';
      yoloMode = on;
      localStorage.setItem('uplink-yolo', String(yoloMode));
      session?.conversation.addSystemMessage(`Auto-approve ${yoloMode ? 'enabled' : 'disabled'}`);
      return undefined;
    }
    case '/session':
      handleSessionCommand(arg);
      return undefined;
    case '/agent':
      applyMode('chat');
      session?.conversation.addSystemMessage('Switched to agent mode');
      return arg || undefined;
    case '/plan':
      applyMode('plan');
      session?.conversation.addSystemMessage('Switched to plan mode');
      return arg || undefined;
    case '/autopilot':
      applyMode('autopilot');
      session?.conversation.addSystemMessage('Switched to autopilot mode');
      return arg || undefined;
  }
  return undefined;
}

async function handleSessionCommand(arg: string): Promise<void> {
  const session = getActiveSession();
  if (!session) return;

  if (arg === 'create' || arg === 'new') {
    const newSession = await createSession(serverCwd);
    switchSession(newSession.slotId);
    return;
  }

  if (arg.startsWith('rename ')) {
    const name = arg.slice(7).trim();
    if (!name || !session.client.currentSessionId) return;
    try {
      await session.client.sendRawRequest('uplink/rename_session', {
        sessionId: session.client.currentSessionId,
        summary: name,
      });
      session.conversation.addSystemMessage(`Session renamed to "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      session.conversation.addSystemMessage(`Failed to rename: ${msg}`);
    }
    return;
  }

  if (arg === 'list' || arg === '') {
    showActiveSessionsModal();
  }
}

// ─── Connect ──────────────────────────────────────────────────────────

initializeClient().catch((err) => {
  console.error('Failed to initialize client:', err);
});
