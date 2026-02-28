import { h } from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';

export interface TerminalPanelProps {
  wsUrl: string;
  visible: boolean;
  onStartChatHere?: () => void;
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

export function TerminalPanel({ wsUrl, visible, onStartChatHere }: TerminalPanelProps) {
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

    ws.addEventListener('close', (event) => {
      setConnected(false);
      term.write('\r\n\x1b[33m[Terminal disconnected]\x1b[0m\r\n');

      // Auto-reconnect unless it was a clean close (user navigated away or component unmounted)
      if (event.code !== 1000 && wsUrl) {
        term.write('\x1b[33m[Reconnecting...]\x1b[0m\r\n');
        setTimeout(() => {
          if (!termRef.current) return;
          const newWs = new WebSocket(wsUrl);
          wsRef.current = newWs;

          newWs.addEventListener('open', () => {
            setConnected(true);
            term.write('\x1b[32m[Reconnected]\x1b[0m\r\n');
            try { fit.fit(); } catch { /* noop */ }
            newWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          });

          newWs.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data as string);
            if (msg.type === 'data') {
              term.write(msg.data);
            }
          });

          newWs.addEventListener('close', () => {
            setConnected(false);
            term.write('\r\n\x1b[33m[Terminal disconnected]\x1b[0m\r\n');
          });

          term.onData((data) => {
            if (newWs.readyState === WebSocket.OPEN) {
              newWs.send(JSON.stringify({ type: 'data', data }));
            }
          });
        }, 2000);
      }
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
  const [selectMode, setSelectMode] = useState(false);
  const [bufferText, setBufferText] = useState('');

  const sendKey = useCallback((key: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'data', data: key }));
    }
  }, []);

  const toggleSelectMode = useCallback(() => {
    if (!selectMode && termRef.current) {
      // Extract visible buffer content as plain text
      const buf = termRef.current.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      setBufferText(lines.join('\n'));
    }
    setSelectMode(!selectMode);
  }, [selectMode]);

  return (
    <div class="terminal-wrapper">
      <div
        ref={containerRef}
        class={`terminal-container ${connected ? '' : 'disconnected'}`}
        style={{ display: selectMode ? 'none' : undefined }}
      />
      {selectMode && (
        <pre class="terminal-select-overlay">{bufferText}</pre>
      )}
      <div class="terminal-mobile-controls">
        {onStartChatHere && (
          <button
            class="terminal-ctrl-btn terminal-ctrl-chat"
            onTouchStart={onStartChatHere ? (e) => { e.preventDefault(); onStartChatHere(); } : undefined}
            onClick={onStartChatHere}
            aria-label="Start Chat Here"
            title="Start Chat Here"
          >
            <span class="material-symbols-outlined">add_comment</span>
          </button>
        )}
        {isMobile && (
          <button
            class={`terminal-ctrl-btn ${selectMode ? 'active' : ''}`}
            onTouchStart={(e) => { e.preventDefault(); toggleSelectMode(); }}
            onClick={toggleSelectMode}
            aria-label="Select text"
          >
            <span class="material-symbols-outlined">{selectMode ? 'terminal' : 'select_all'}</span>
          </button>
        )}
        <div class="terminal-ctrl-spacer" />
        <button class="terminal-ctrl-btn" onTouchStart={(e) => { e.preventDefault(); sendKey('\x1b[A'); }} onClick={() => sendKey('\x1b[A')} aria-label="Up">
          <span class="material-symbols-outlined">keyboard_arrow_up</span>
        </button>
        <button class="terminal-ctrl-btn" onTouchStart={(e) => { e.preventDefault(); sendKey('\x1b[B'); }} onClick={() => sendKey('\x1b[B')} aria-label="Down">
          <span class="material-symbols-outlined">keyboard_arrow_down</span>
        </button>
      </div>
    </div>
  );
}
