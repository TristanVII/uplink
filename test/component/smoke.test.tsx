/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { h } from 'preact';

afterEach(cleanup);

function Greeting({ name }: { name: string }) {
  return <span>Hello, {name}!</span>;
}

describe('Preact smoke test', () => {
  it('renders a component', () => {
    render(<Greeting name="Uplink" />);
    expect(screen.getByText('Hello, Uplink!')).toBeTruthy();
  });
});
