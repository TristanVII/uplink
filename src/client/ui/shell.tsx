import { h } from 'preact';

interface ShellOutputProps {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Render shell command output as a terminal-styled block. */
export function ShellOutput({ command, stdout, stderr, exitCode }: ShellOutputProps) {
  return (
    <div class="shell-output">
      <div class="command">$ {command}</div>
      {stdout && <pre class="stdout">{stdout}</pre>}
      {stderr && <pre class="stderr">{stderr}</pre>}
      {exitCode !== 0 && <div class="exit-code">exit code {exitCode}</div>}
    </div>
  );
}
