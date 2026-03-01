import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList } from './ui/chat.js';
import { showPermissionRequest, cancelAllPermissions } from './ui/permission.js';
import { fetchSessions, openSessionsModal, SessionsModal } from './ui/sessions.js';
import { CommandPalette, type PaletteItem } from './ui/command-palette.js';
import { getCompletions, parseSlashCommand, setAvailableModels, findModelName } from './slash-commands.js';
import { TabBar, type TabId } from './ui/tab-bar.js';
import { DirectoriesView } from './ui/directories.js';
import { render, h } from 'preact';
import 'material-symbols/outlined.css';

// ─── DOM References ───────────────────────────────────────────────────

const chatArea = document.getElementById('chat-area')!;
const directoriesMount = document.getElementById('directories-mount')!;
const tabBarMount = document.getElementById('tab-bar-mount')!;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const modelLabel = document.getElementById('model-label')!;
const inputArea = document.getElementById('input-area')!;
const dirLabel = document.getElementById('dir-label')!;

let yoloMode = localStorage.getItem('uplink-yolo') === 'true';

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

// ─── Multi-Dir State ──────────────────────────────────────────────────

let multiDirMode = false;
let configuredDirs: string[] = [];
let activeTab: TabId = 'directories';
let activeDirCwd: string | null = null;
let sessionToken: string = '';

/** Per-directory state: client + conversation preserved across tab switches. */
interface DirContext {
  client: AcpClient;
  conversation: Conversation;
}
const dirContexts = new Map<string, DirContext>();

/** Extract short display name from path (last 2 segments). */
function shortDirName(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || dir;
}

function updateDirLabel(dir: string | null): void {
  if (!multiDirMode || !dir) {
    dirLabel.hidden = true;
    return;
  }
  dirLabel.textContent = shortDirName(dir);
  dirLabel.title = dir;
  dirLabel.hidden = false;
}

function renderTabBar(): void {
  if (!multiDirMode) return;
  render(
    h(TabBar, {
      activeTab,
      onTabChange: switchTab,
      chatDirName: activeDirCwd ? shortDirName(activeDirCwd) : undefined,
    }),
    tabBarMount,
  );
}

function renderDirectories(): void {
  render(
    h(DirectoriesView, {
      dirs: configuredDirs,
      activeCwd: activeDirCwd ?? undefined,
      onSelect: (dir: string) => connectToDirectory(dir),
    }),
    directoriesMount,
  );
}

function switchTab(tab: TabId): void {
  activeTab = tab;
  if (tab === 'directories') {
    chatArea.hidden = true;
    inputArea.hidden = true;
    directoriesMount.hidden = false;
    renderDirectories();
  } else {
    chatArea.hidden = false;
    inputArea.hidden = false;
    directoriesMount.hidden = true;
  }
  renderTabBar();
}

/** Get or create a DirContext for a directory, connecting the AcpClient. */
function getOrCreateDirContext(dir: string): DirContext {
  let ctx = dirContexts.get(dir);
  if (ctx) return ctx;

  const conv = new Conversation();
  const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(sessionToken)}&cwd=${encodeURIComponent(dir)}`;
  const acpClient = new AcpClient({
    wsUrl,
    cwd: dir,
    onStateChange: (state) => {
      // Only update UI if this dir is the active one
      if (activeDirCwd === dir) updateConnectionStatus(state, conv);
    },
    onSessionUpdate: (update) => {
      conv.handleSessionUpdate(update);
    },
    onModelsAvailable: (models, currentModelId) => {
      if (activeDirCwd === dir) {
        setAvailableModels(models);
        if (currentModelId) {
          const model = models.find((m) => m.modelId === currentModelId);
          modelLabel.textContent = model?.name ?? currentModelId;
          modelLabel.hidden = false;
        }
      }
    },
    onPermissionRequest: (request, respond) => {
      const autoApproveId = yoloMode
        ? request.options.find(
            (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
          )?.optionId
        : undefined;

      showPermissionRequest(
        conv,
        request.id,
        request.toolCall.toolCallId,
        request.toolCall.title ?? 'Unknown action',
        request.options,
        respond,
        autoApproveId,
      );
    },
    onError: (error) => console.error('ACP error:', error),
  });

  ctx = { client: acpClient, conversation: conv };
  dirContexts.set(dir, ctx);
  return ctx;
}

async function connectToDirectory(dir: string): Promise<void> {
  const ctx = getOrCreateDirContext(dir);
  activeDirCwd = dir;
  clientCwd = dir;
  client = ctx.client;
  activeConversation = ctx.conversation;
  updateDirLabel(dir);
  renderChat();

  switchTab('chat');

  // Connect if not already connected
  if (ctx.client.connectionState === 'disconnected') {
    await ctx.client.connect();
  } else {
    // Already connected — just refresh the connection status UI
    updateConnectionStatus(ctx.client.connectionState, ctx.conversation);
  }
}

// ─── Service Worker ───────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// ─── UI Components ────────────────────────────────────────────────────

let activeConversation = new Conversation();

// Mount all timeline components into a single chatContainer.
const chatContainer = document.createElement('div');
chatContainer.className = 'chat-container chat-messages';
chatArea.appendChild(chatContainer);

function renderChat(): void {
  render(
    h(ChatList, { conversation: activeConversation, scrollContainer: chatArea }),
    chatContainer,
  );
}
renderChat();

// Mount Preact sessions modal on body
const sessionsModalContainer = document.createElement('div');
document.body.appendChild(sessionsModalContainer);
render(h(SessionsModal, {}), sessionsModalContainer);

/** Clear all conversation state when session changes. */
function clearConversation(): void {
  activeConversation.clear();
  cancelAllPermissions(activeConversation);
}

// ─── WebSocket / ACP Client ──────────────────────────────────────────

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

let client: AcpClient | null = null;
let clientCwd: string = '';

function updateConnectionStatus(state: ConnectionState, conv?: Conversation): void {
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

  sendBtn.disabled = state !== 'ready';
  sendBtn.hidden = state === 'prompting';
  cancelBtn.hidden = state !== 'prompting';

  const c = conv ?? activeConversation;
  c.isPrompting = state === 'prompting';
  c.notify();
}

/** Create an AcpClient for single-dir mode (uses activeConversation directly). */
function createAcpClient(wsUrl: string, cwd: string): AcpClient {
  return new AcpClient({
    wsUrl,
    cwd,
    onStateChange: (state) => updateConnectionStatus(state),
    onSessionUpdate: (update) => activeConversation.handleSessionUpdate(update),
    onModelsAvailable: (models, currentModelId) => {
      setAvailableModels(models);
      if (currentModelId) {
        const model = models.find((m) => m.modelId === currentModelId);
        modelLabel.textContent = model?.name ?? currentModelId;
        modelLabel.hidden = false;
      }
    },
    onPermissionRequest: (request, respond) => {
      const autoApproveId = yoloMode
        ? request.options.find(
            (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
          )?.optionId
        : undefined;

      showPermissionRequest(
        activeConversation,
        request.id,
        request.toolCall.toolCallId,
        request.toolCall.title ?? 'Unknown action',
        request.options,
        respond,
        autoApproveId,
      );
    },
    onError: (error) => console.error('ACP error:', error),
  });
}

// ─── Input Handling ───────────────────────────────────────────────────

sendBtn.addEventListener('click', async () => {
  const text = promptInput.value.trim();
  if (!text || !client) return;

  promptInput.value = '';
  promptInput.style.height = 'auto';
  hidePalette();
  document.documentElement.setAttribute('data-mode', currentMode);

  // Shell commands: !<command>
  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (!command) return;

    activeConversation.addUserMessage(`$ ${command}`);

    try {
      const result = await client.sendRawRequest<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>('uplink/shell', { command });
      activeConversation.addShellResult(command, result.stdout, result.stderr, result.exitCode);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      activeConversation.addShellResult(command, '', errorMessage, 1);
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
      if (name) {
        modelLabel.textContent = name;
        modelLabel.hidden = false;
      }
    }
  }

  activeConversation.addUserMessage(text);

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
      activeConversation.addUserMessage('continue');
      stopReason = await client.prompt('continue');
    }
    if (turns >= MAX_AUTOPILOT_TURNS) {
      activeConversation.addSystemMessage('Autopilot stopped: reached maximum turns');
    }
  } catch (err) {
    console.error('Prompt error:', err);
  }
});

cancelBtn.addEventListener('click', () => {
  client?.cancel();
  cancelAllPermissions(activeConversation);
  // Stop autopilot auto-continue loop by switching back to chat mode
  if (currentMode === 'autopilot') {
    applyMode('chat');
    activeConversation.addSystemMessage('Autopilot cancelled');
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
  switch (command) {
    case '/theme':
      applyTheme(arg || 'auto');
      activeConversation.addSystemMessage(`Theme set to ${arg || 'auto'}`);
      return undefined;
    case '/yolo': {
      const on = arg === '' || arg === 'on';
      yoloMode = on;
      localStorage.setItem('uplink-yolo', String(yoloMode));
      activeConversation.addSystemMessage(`Auto-approve ${yoloMode ? 'enabled' : 'disabled'}`);
      return undefined;
    }
    case '/session':
      handleSessionCommand(arg);
      return undefined;
    case '/agent':
      applyMode('chat');
      activeConversation.addSystemMessage('Switched to agent mode');
      return arg || undefined;
    case '/plan':
      applyMode('plan');
      activeConversation.addSystemMessage('Switched to plan mode');
      return arg || undefined;
    case '/autopilot':
      applyMode('autopilot');
      activeConversation.addSystemMessage('Switched to autopilot mode');
      return arg || undefined;
  }
  return undefined;
}

async function handleSessionCommand(arg: string): Promise<void> {
  if (!client || !clientCwd) return;

  if (arg === 'create' || arg === 'new') {
    clearConversation();
    try {
      await client.newSession();
    } catch (err) {
      console.error('Failed to create new session:', err);
    }
    return;
  }

  if (arg.startsWith('rename ')) {
    const name = arg.slice(7).trim();
    if (!name || !client.currentSessionId) return;
    try {
      await client.sendRawRequest('uplink/rename_session', {
        sessionId: client.currentSessionId,
        summary: name,
      });
      activeConversation.addSystemMessage(`Session renamed to "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      activeConversation.addSystemMessage(`Failed to rename: ${msg}`);
    }
    return;
  }

  if (arg === 'list' || arg === '') {
    const sessions = await fetchSessions(clientCwd);
    openSessionsModal(
      sessions,
      client.supportsLoadSession,
      async (sessionId) => {
        clearConversation();
        try {
          await client!.loadSession(sessionId);
        } catch (err) {
          console.error('Failed to load session:', err);
        }
      },
      async () => {
        clearConversation();
        try {
          await client!.newSession();
        } catch (err) {
          console.error('Failed to create new session:', err);
        }
      },
    );
  }
}

// ─── Mobile keyboard handling ─────────────────────────────────────────
// Chrome/Edge: VirtualKeyboard API gives env(keyboard-inset-height) in CSS.
// Safari/iOS:  dvh doesn't track the keyboard, so we sync #app to the
//              visual viewport — height for the keyboard, translateY for
//              the scroll offset iOS applies when focusing an input.
const appEl = document.getElementById('app')!;

if ('virtualKeyboard' in navigator) {
  (navigator as any).virtualKeyboard.overlaysContent = true;
} else if (window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    appEl.style.height = `${vv.height}px`;
    appEl.style.transform = `translateY(${vv.offsetTop}px)`;
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
}

// ─── Connect ──────────────────────────────────────────────────────────

updateConnectionStatus('disconnected');

async function boot(): Promise<void> {
  // Fetch token and config in parallel
  const [tokenRes, configRes] = await Promise.all([
    fetch('/api/token'),
    fetch('/api/config'),
  ]);
  const { token, cwd } = await tokenRes.json();
  const config = await configRes.json();

  sessionToken = token;
  clientCwd = cwd;

  if (config.multiDir && config.dirs.length > 0) {
    // Multi-directory mode
    multiDirMode = true;
    configuredDirs = config.dirs;
    document.getElementById('app')!.classList.add('has-tab-bar');

    // Start on directories tab
    switchTab('directories');
    renderTabBar();
  } else {
    // Single-directory mode (original behavior)
    const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
    client = createAcpClient(wsUrl, cwd);
    activeDirCwd = cwd;
    await client.connect();
  }
}

boot().catch((err) => {
  console.error('Failed to initialize client:', err);
});
