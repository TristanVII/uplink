import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { h } from 'preact';
import { ShellOutput } from '../../src/client/ui/shell.js';

afterEach(cleanup);

describe('ShellOutput', () => {
  it('renders command header', () => {
    render(<ShellOutput command="echo hi" stdout="hi" stderr="" exitCode={0} />);
    expect(screen.getByText('$ echo hi')).toBeTruthy();
  });

  it('renders stdout', () => {
    render(<ShellOutput command="ls" stdout="file.txt" stderr="" exitCode={0} />);
    expect(screen.getByText('file.txt')).toBeTruthy();
  });

  it('renders stderr', () => {
    render(<ShellOutput command="bad" stdout="" stderr="not found" exitCode={1} />);
    expect(screen.getByText('not found')).toBeTruthy();
  });

  it('shows exit code when non-zero', () => {
    render(<ShellOutput command="fail" stdout="" stderr="" exitCode={42} />);
    expect(screen.getByText('exit code 42')).toBeTruthy();
  });

  it('hides exit code when zero', () => {
    render(<ShellOutput command="ok" stdout="done" stderr="" exitCode={0} />);
    expect(screen.queryByText(/exit code/)).toBeNull();
  });

  it('hides stdout when empty', () => {
    const { container } = render(
      <ShellOutput command="quiet" stdout="" stderr="" exitCode={0} />,
    );
    expect(container.querySelector('.stdout')).toBeNull();
  });

  it('hides stderr when empty', () => {
    const { container } = render(
      <ShellOutput command="clean" stdout="ok" stderr="" exitCode={0} />,
    );
    expect(container.querySelector('.stderr')).toBeNull();
  });

  it('renders all parts together', () => {
    const { container } = render(
      <ShellOutput command="mixed" stdout="output" stderr="warning" exitCode={2} />,
    );
    expect(screen.getByText('$ mixed')).toBeTruthy();
    expect(screen.getByText('output')).toBeTruthy();
    expect(screen.getByText('warning')).toBeTruthy();
    expect(screen.getByText('exit code 2')).toBeTruthy();
    expect(container.querySelector('.shell-output')).toBeTruthy();
  });
});
