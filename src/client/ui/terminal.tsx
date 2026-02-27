import { h } from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';

export interface TerminalPanelProps {
  wsUrl: string;
  visible: boolean;
}

const THEME_DARK = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#45475a',
  selectionForeground: '#cdd6f4',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#cba6f7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

const THEME_LIGHT = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  cursor: '#dc8a78',
  cursorAccent: '#eff1f5',
  selectionBackground: '#ccd0da',
  selectionForeground: '#4c4f69',
  black: '#5c5f77',
  red: '#d20f39',
  green: '#40a02b',
  yellow: '#df8e1d',
  blue: '#1e66f5',
  magenta: '#8839ef',
  cyan: '#179299',
  white: '#acb0be',
  brightBlack: '#6c6f85',
  brightRed: '#d20f39',
  brightGreen: '#40a02b',
  brightYellow: '#df8e1d',
  brightBlue: '#1e66f5',
  brightMagenta: '#8839ef',
  brightCyan: '#179299',
  brightWhite: '#bcc0cc',
};

function getTheme(): typeof THEME_DARK {
  return document.documentElement.classList.contains('light') ? THEME_LIGHT : THEME_DARK;
}

export function TerminalPanel({ wsUrl, visible }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: window.innerWidth <= 600 ? 11 : 14,
      theme: getTheme(),
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new ClipboardAddon());
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    // Connect WebSocket
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      setConnected(true);
      fit.fit();
      // Send initial size
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === 'data') {
        term.write(msg.data);
      }
    });

    ws.addEventListener('close', () => {
      setConnected(false);
      term.write('\r\n\x1b[33m[Terminal disconnected]\x1b[0m\r\n');
    });

    // Terminal input -> WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    // Handle resize with debounce to avoid rapid refit
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!fitRef.current || !termRef.current) return;
        try {
          fitRef.current.fit();
        } catch {
          // container may not be visible
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
        }
      }, 100);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [wsUrl]);

  // Refit when visibility changes
  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      // Delay to let the container become visible before measuring
      setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          return;
        }
        termRef.current?.focus();
        // Sync size to server
        if (wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
        }
      }, 100);
    }
  }, [visible]);

  // Sync theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      termRef.current?.options && (termRef.current.options.theme = getTheme());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 600;

  const sendKey = useCallback((key: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'data', data: key }));
    }
  }, []);

  const handleCopy = useCallback(async () => {
    const sel = termRef.current?.getSelection();
    if (sel) {
      try { await navigator.clipboard.writeText(sel); } catch { /* noop */ }
    }
  }, []);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendKey(text);
    } catch { /* noop */ }
  }, [sendKey]);

  return (
    <div class="terminal-wrapper">
      <div
        ref={containerRef}
        class={`terminal-container ${connected ? '' : 'disconnected'}`}
      />
      {isMobile && (
        <div class="terminal-mobile-controls">
          <button class="terminal-ctrl-btn" onTouchStart={(e) => { e.preventDefault(); handleCopy(); }} onClick={handleCopy} aria-label="Copy">
            <span class="material-symbols-outlined">content_copy</span>
          </button>
          <button class="terminal-ctrl-btn" onTouchStart={(e) => { e.preventDefault(); handlePaste(); }} onClick={handlePaste} aria-label="Paste">
            <span class="material-symbols-outlined">content_paste</span>
          </button>
          <div class="terminal-ctrl-spacer" />
          <button class="terminal-ctrl-btn" onTouchStart={(e) => { e.preventDefault(); sendKey('\x1b[A'); }} onClick={() => sendKey('\x1b[A')} aria-label="Up">
            <span class="material-symbols-outlined">keyboard_arrow_up</span>
          </button>
          <button class="terminal-ctrl-btn" onTouchStart={(e) => { e.preventDefault(); sendKey('\x1b[B'); }} onClick={() => sendKey('\x1b[B')} aria-label="Down">
            <span class="material-symbols-outlined">keyboard_arrow_down</span>
          </button>
        </div>
      )}
    </div>
  );
}
