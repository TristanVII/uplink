import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList } from './ui/chat.js';
import { TerminalPanel } from './ui/terminal.js';
import { showPermissionRequest, cancelAllPermissions } from './ui/permission.js';
import { openSessionsModal, SessionsModal } from './ui/sessions.js';
import { CommandPalette, type PaletteItem } from './ui/command-palette.js';
import { getCompletions, parseSlashCommand, setAvailableModels, findModelName } from './slash-commands.js';
import { render, h } from 'preact';
import 'material-symbols/outlined.css';

// ─── Constants ────────────────────────────────────────────────────────

const MAX_CHAT_TABS = 4;

// ─── DOM References ───────────────────────────────────────────────────

const terminalArea = document.getElementById('terminal-area')!;
const chatPanelsContainer = document.getElementById('chat-panels')!;
const tabBar = document.getElementById('tab-bar')!;

let yoloMode = localStorage.getItem('uplink-yolo') === 'true';

// ─── Multi-Tab Session State ──────────────────────────────────────────

interface ChatSession {
  slotId: string;
  cwd: string;
  client: AcpClient;
  conversation: Conversation;
  panel: HTMLElement;
}

/** Per-session palette state */
interface PaletteState {
  items: PaletteItem[];
  selectedIndex: number;
  visible: boolean;
}

const sessions = new Map<string, ChatSession>();
const paletteStates = new Map<string, PaletteState>();
let activeTab: 'terminal' | string = 'terminal'; // 'terminal' or a slotId

function getActiveSession(): ChatSession | null {
  if (activeTab === 'terminal') return null;
  return sessions.get(activeTab) ?? null;
}

// ─── Tab Switching ────────────────────────────────────────────────────

function switchTab(tab: 'terminal' | string): void {
  activeTab = tab;

  // Update tab button states
  tabBar.querySelectorAll<HTMLButtonElement>('.tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Toggle terminal visibility
  terminalArea.hidden = tab !== 'terminal';

  // Toggle chat panels
  for (const [slotId, session] of sessions) {
    session.panel.hidden = slotId !== tab;
  }

  renderTerminal();

  // Update connection status
  const session = getActiveSession();
  if (session) {
    updateConnectionStatus(session.client.connectionState);
  } else {
    // Terminal tab — show neutral status
    const el = document.getElementById('connection-status')!;
    el.textContent = 'Terminal';
    el.className = 'status-connected';
  }
}

// Wire up the static terminal tab button
tabBar.querySelector<HTMLButtonElement>('[data-tab="terminal"]')!
  .addEventListener('click', () => switchTab('terminal'));

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

// ─── Sessions Modal ───────────────────────────────────────────────────

const sessionsModalContainer = document.createElement('div');
document.body.appendChild(sessionsModalContainer);
render(h(SessionsModal, {}), sessionsModalContainer);

// ─── Terminal Panel ───────────────────────────────────────────────────

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

// ─── Chat Panel DOM Factory ───────────────────────────────────────────

function createChatPanel(slotId: string): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.dataset.slotId = slotId;
  panel.hidden = true;

  // Scrollable messages area
  const chatArea = document.createElement('div');
  chatArea.className = 'chat-area';

  const chatContainer = document.createElement('div');
  chatContainer.className = 'chat-container chat-messages';
  chatArea.appendChild(chatContainer);

  // Input footer
  const inputArea = document.createElement('div');
  inputArea.className = 'input-area';

  const paletteMount = document.createElement('div');
  paletteMount.className = 'palette-mount';

  const inputWrapper = document.createElement('div');
  inputWrapper.className = 'input-wrapper';

  const textarea = document.createElement('textarea');
  textarea.className = 'prompt-input';
  textarea.placeholder = 'Ask anything…';
  textarea.rows = 1;

  const modelLabel = document.createElement('span');
  modelLabel.className = 'model-label';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'send-btn';
  sendBtn.textContent = 'Send';
  sendBtn.disabled = true;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.hidden = true;

  inputWrapper.append(textarea, modelLabel);
  inputArea.append(paletteMount, inputWrapper, sendBtn, cancelBtn);
  panel.append(chatArea, inputArea);
  chatPanelsContainer.appendChild(panel);

  // ── Per-panel event wiring ──

  const ps: PaletteState = { items: [], selectedIndex: 0, visible: false };
  paletteStates.set(slotId, ps);

  function renderPanelPalette(): void {
    if (!ps.visible || ps.items.length === 0) {
      render(null, paletteMount);
      return;
    }
    render(
      h(CommandPalette, {
        items: ps.items,
        selectedIndex: ps.selectedIndex,
        onSelect: (item: PaletteItem) => acceptPanelCompletion(item),
        onHover: (i: number) => { ps.selectedIndex = i; renderPanelPalette(); },
      }),
      paletteMount,
    );
  }

  function showPanelPalette(): void {
    ps.items = getCompletions(textarea.value);
    ps.selectedIndex = 0;
    ps.visible = ps.items.length > 0;
    renderPanelPalette();
  }

  function hidePanelPalette(): void {
    ps.visible = false;
    renderPanelPalette();
  }

  function acceptPanelCompletion(item: PaletteItem): void {
    textarea.value = item.fill;
    textarea.focus();
    updatePanelBorderPreview();
    if (item.fill.endsWith(' ')) {
      showPanelPalette();
    } else {
      hidePanelPalette();
      sendBtn.click();
    }
  }

  function updatePanelBorderPreview(): void {
    if (textarea.value.startsWith('!')) {
      document.documentElement.setAttribute('data-mode', 'shell-input');
    } else if (textarea.value.startsWith('/')) {
      const parts = textarea.value.slice(1).split(/\s/, 1);
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

  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    const maxH = 150;
    const scrollH = textarea.scrollHeight;
    textarea.style.height = Math.min(scrollH, maxH) + 'px';
    textarea.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';
    updatePanelBorderPreview();
    if (textarea.value.startsWith('/')) {
      showPanelPalette();
    } else {
      hidePanelPalette();
    }
  });

  // Keyboard handling
  textarea.addEventListener('keydown', (e) => {
    if (ps.visible) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        ps.selectedIndex = Math.max(0, ps.selectedIndex - 1);
        renderPanelPalette();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        ps.selectedIndex = Math.min(ps.items.length - 1, ps.selectedIndex + 1);
        renderPanelPalette();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        if (ps.items[ps.selectedIndex]) {
          acceptPanelCompletion(ps.items[ps.selectedIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hidePanelPalette();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // Send
  sendBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    const session = sessions.get(slotId);
    if (!text || !session) return;

    const { client, conversation } = session;
    textarea.value = '';
    textarea.style.height = 'auto';
    hidePanelPalette();
    document.documentElement.setAttribute('data-mode', currentMode);

    // Shell commands
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (!command) return;
      conversation.addUserMessage(`$ ${command}`);
      try {
        const result = await client.sendRawRequest<{
          stdout: string; stderr: string; exitCode: number;
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
        promptText = remainingPrompt;
      } else if (parsed.command === '/model' && parsed.arg) {
        const name = findModelName(parsed.arg);
        if (name) modelLabel.textContent = name;
      }
    }

    conversation.addUserMessage(text);

    if (currentMode === 'plan' && !text.startsWith('/')) {
      promptText = `/plan ${promptText}`;
    }

    const MAX_AUTOPILOT_TURNS = 25;
    try {
      let stopReason = await client.prompt(promptText);
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

  // Cancel
  cancelBtn.addEventListener('click', () => {
    const session = sessions.get(slotId);
    if (session) {
      session.client.cancel();
      cancelAllPermissions(session.conversation);
    }
    if (currentMode === 'autopilot') {
      applyMode('chat');
      sessions.get(slotId)?.conversation.addSystemMessage('Autopilot cancelled');
    }
  });

  return panel;
}

// ─── Chat Rendering ───────────────────────────────────────────────────

function renderChat(slotId: string): void {
  const session = sessions.get(slotId);
  if (!session) return;
  const chatArea = session.panel.querySelector<HTMLElement>('.chat-area')!;
  const chatContainer = session.panel.querySelector<HTMLElement>('.chat-container')!;
  render(
    h(ChatList, { conversation: session.conversation, scrollContainer: chatArea }),
    chatContainer,
  );
}

// ─── Tab Bar Management ───────────────────────────────────────────────

function addTabButton(slotId: string, cwd: string): void {
  const folderName = cwd.split('/').pop() || cwd;

  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.tab = slotId;

  const statusDot = document.createElement('span');
  statusDot.className = 'tab-status tab-status-connecting';
  statusDot.title = 'Connecting…';

  const label = document.createElement('span');
  label.textContent = `📁 ${folderName}`;
  label.title = cwd;

  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSession(slotId);
  });

  btn.append(statusDot, label, closeBtn);
  btn.addEventListener('click', () => switchTab(slotId));
  tabBar.appendChild(btn);
}

function updateTabStatus(slotId: string, state: ConnectionState): void {
  const btn = tabBar.querySelector<HTMLButtonElement>(`[data-tab="${slotId}"]`);
  if (!btn) return;
  const dot = btn.querySelector<HTMLElement>('.tab-status');
  if (!dot) return;

  // Map state to visual class
  if (state === 'prompting') {
    dot.className = 'tab-status tab-status-running';
    dot.title = 'Running…';
  } else if (state === 'ready') {
    dot.className = 'tab-status tab-status-idle';
    dot.title = 'Idle';
  } else if (state === 'connecting' || state === 'initializing') {
    dot.className = 'tab-status tab-status-connecting';
    dot.title = 'Connecting…';
  } else {
    dot.className = 'tab-status tab-status-disconnected';
    dot.title = 'Disconnected';
  }
}

function removeTabButton(slotId: string): void {
  const btn = tabBar.querySelector<HTMLButtonElement>(`[data-tab="${slotId}"]`);
  btn?.remove();
}

// ─── Connection Status ────────────────────────────────────────────────

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
let sessionToken = '';
let serverCwd = '';

function updateConnectionStatus(state: ConnectionState): void {
  const el = document.getElementById('connection-status')!;
  const displayState = state === 'prompting' ? 'ready' : state;
  el.textContent = displayState;
  el.className = `status-${
    state === 'ready' || state === 'prompting'
      ? 'connected'
      : state === 'connecting' || state === 'initializing'
        ? 'reconnecting'
        : 'disconnected'
  }`;

  // Update send/cancel buttons for the active session's panel
  const session = getActiveSession();
  if (session) {
    const sendBtn = session.panel.querySelector<HTMLButtonElement>('.send-btn')!;
    const cancelBtn = session.panel.querySelector<HTMLButtonElement>('.cancel-btn')!;
    sendBtn.disabled = state !== 'ready';
    sendBtn.hidden = state === 'prompting';
    cancelBtn.hidden = state !== 'prompting';

    session.conversation.isPrompting = state === 'prompting';
    session.conversation.notify();
  }
}

// ─── ACP Client Factory ──────────────────────────────────────────────

function createClientForSlot(slotId: string, cwd: string): AcpClient {
  const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(sessionToken)}&slotId=${encodeURIComponent(slotId)}`;

  return new AcpClient({
    wsUrl,
    cwd,
    onStateChange: (state) => {
      updateTabStatus(slotId, state);
      if (activeTab === slotId) {
        updateConnectionStatus(state);
      }
    },
    onSessionUpdate: (update) => {
      const s = sessions.get(slotId);
      if (s) {
        s.conversation.handleSessionUpdate(update);
        if (activeTab === slotId) renderChat(slotId);
      }
    },
    onModelsAvailable: (models, currentModelId) => {
      setAvailableModels(models);
      if (currentModelId) {
        const session = sessions.get(slotId);
        if (session) {
          const model = models.find((m) => m.modelId === currentModelId);
          const label = session.panel.querySelector<HTMLElement>('.model-label');
          if (label) label.textContent = model?.name ?? currentModelId;
        }
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

// ─── Session Lifecycle ────────────────────────────────────────────────

async function createSession(cwd: string): Promise<ChatSession> {
  const res = await fetch('/api/sessions/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  const { slotId, cwd: resolvedCwd } = await res.json();

  const client = createClientForSlot(slotId, resolvedCwd);
  const conversation = new Conversation();
  const panel = createChatPanel(slotId);

  // Re-render chat on conversation changes
  conversation.onChange(() => {
    if (activeTab === slotId) renderChat(slotId);
  });

  const session: ChatSession = { slotId, cwd: resolvedCwd, client, conversation, panel };
  sessions.set(slotId, session);

  addTabButton(slotId, resolvedCwd);
  client.connect().catch(console.error);
  return session;
}

async function closeSession(slotId: string): Promise<void> {
  const session = sessions.get(slotId);
  if (!session) return;

  // Disconnect client and clean up
  session.client.disconnect();
  session.panel.remove();
  sessions.delete(slotId);
  paletteStates.delete(slotId);
  removeTabButton(slotId);

  // Tell the server to destroy the session slot
  fetch(`/api/sessions/active/${encodeURIComponent(slotId)}`, { method: 'DELETE' }).catch(console.error);

  // Switch to another tab
  if (activeTab === slotId) {
    const remaining = [...sessions.keys()];
    switchTab(remaining.length > 0 ? remaining[remaining.length - 1] : 'terminal');
  }
}

// ─── "Start Chat Here" handler ────────────────────────────────────────

async function handleStartChatHere(): Promise<void> {
  if (sessions.size >= MAX_CHAT_TABS) {
    console.warn(`Cannot open more than ${MAX_CHAT_TABS} chat tabs`);
    return;
  }

  try {
    const res = await fetch('/api/terminal/cwd');
    const { cwd } = await res.json();
    const session = await createSession(cwd);
    switchTab(session.slotId);
    session.conversation.addSystemMessage(`Session started in ${cwd}`);
  } catch (err) {
    console.error('Failed to start chat:', err);
  }
}

// ─── Active Sessions Modal ────────────────────────────────────────────

async function showActiveSessionsModal(): Promise<void> {
  const res = await fetch('/api/sessions/active');
  const { sessions: activeSlots } = await res.json() as { sessions: { slotId: string; cwd: string; connected: boolean }[] };

  openSessionsModal(
    activeSlots.map(s => ({
      id: s.slotId,
      cwd: s.cwd,
      summary: s.cwd.split('/').pop() || s.cwd,
      branch: s.cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    true,
    (slotId) => {
      if (sessions.has(slotId)) {
        switchTab(slotId);
      }
    },
    async () => {
      if (sessions.size >= MAX_CHAT_TABS) return;
      const session = await createSession(serverCwd);
      switchTab(session.slotId);
    },
  );
}

// ─── Slash Command Handlers ───────────────────────────────────────────

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
    if (sessions.size >= MAX_CHAT_TABS) return;
    const newSession = await createSession(serverCwd);
    switchTab(newSession.slotId);
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

// ─── Initialize ───────────────────────────────────────────────────────

async function initialize(): Promise<void> {
  const tokenResponse = await fetch('/api/token');
  const { token, cwd } = await tokenResponse.json();
  sessionToken = token;
  serverCwd = cwd;

  terminalWsUrl = `${wsProtocol}//${location.host}/ws/terminal?token=${encodeURIComponent(token)}`;
  renderTerminal();

  // Start on the terminal tab — no chat session created
  switchTab('terminal');
}

initialize().catch((err) => {
  console.error('Failed to initialize:', err);
});
