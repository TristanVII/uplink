import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatUI } from './ui/chat.js';

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// Create instances
const conversation = new Conversation();

const chatUI = new ChatUI(
  document.getElementById('chat-area')!,
  conversation,
);
chatUI.attach();

// Determine WS URL (same origin)
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${location.host}/ws`;

const client = new AcpClient({
  wsUrl,
  cwd: '.',
  onStateChange: (state) => updateConnectionStatus(state),
  onSessionUpdate: (update) => conversation.handleSessionUpdate(update),
  onPermissionRequest: (request, respond) => {
    // TODO: wire to permission UI
    console.log('Permission requested:', request);
    void respond;
  },
  onError: (error) => console.error('ACP error:', error),
});

// Connection status UI
function updateConnectionStatus(state: ConnectionState): void {
  const el = document.getElementById('connection-status')!;
  el.textContent = state;
  el.className = `status-${
    state === 'ready' || state === 'prompting'
      ? 'connected'
      : state === 'connecting' || state === 'initializing'
        ? 'reconnecting'
        : 'disconnected'
  }`;

  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
  sendBtn.disabled = state !== 'ready';
  cancelBtn.hidden = state !== 'prompting';
}

// Input handling
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

sendBtn.addEventListener('click', async () => {
  const text = promptInput.value.trim();
  if (!text) return;

  conversation.addUserMessage(text);
  promptInput.value = '';
  promptInput.style.height = 'auto';

  try {
    await client.prompt(text);
  } catch (err) {
    console.error('Prompt error:', err);
  }
});

cancelBtn.addEventListener('click', () => {
  client.cancel();
});

// Enter to send (Shift+Enter for newline)
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// Auto-resize textarea
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
});

// Connect!
client.connect();
