import { type IPty, spawn as ptySpawn } from 'node-pty';

export interface TerminalOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

/** Build a clean string-only env from process.env (node-pty requires all values to be strings). */
function sanitizeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

export class TerminalSession {
  private pty: IPty;
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((code: number) => void) | null = null;

  constructor(options: TerminalOptions) {
    const shell = defaultShell();
    const env = options.env ?? sanitizeEnv();

    this.pty = ptySpawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: options.cwd,
      env,
    });

    this.pty.onData((data) => {
      this.dataCallback?.(data);
    });

    this.pty.onExit(({ exitCode }) => {
      this.exitCallback?.(exitCode);
    });
  }

  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (code: number) => void): void {
    this.exitCallback = callback;
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(): void {
    try {
      this.pty.kill();
    } catch {
      // ignore — process may already be dead
    }
  }
}
