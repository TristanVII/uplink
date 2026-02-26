/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/preact';
import { h } from 'preact';
import { Conversation } from '../../src/client/conversation.js';
import { ToolCallList } from '../../src/client/ui/tool-call.js';

afterEach(cleanup);

function makeConversation() {
  return new Conversation();
}

describe('ToolCallList', () => {
  it('renders a tool call with icon, title, and status', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read file.ts',
      kind: 'read',
      status: 'pending',
    });

    const { container } = render(<ToolCallList conversation={conv} />);

    expect(container.querySelector('.kind-icon')!.textContent).toBe('📖');
    expect(container.querySelector('.tool-call-title')!.textContent).toBe('Read file.ts');
    expect(container.querySelector('.status')!.textContent).toBe('pending');
  });

  it('updates status when tool call progresses', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      title: 'Edit main.ts',
      kind: 'edit',
      status: 'pending',
    });

    const { container } = render(<ToolCallList conversation={conv} />);
    expect(container.querySelector('.status')!.textContent).toBe('pending');

    act(() => {
      conv.handleSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        status: 'completed',
      });
    });

    expect(container.querySelector('.status')!.textContent).toBe('completed');
  });

  it('renders thinking block as <details>', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'think-1',
      title: '',
      kind: 'think',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'Analyzing...' } }],
    });

    const { container } = render(<ToolCallList conversation={conv} />);

    const details = container.querySelector('details.tool-call-thinking');
    expect(details).toBeTruthy();
    expect(container.querySelector('.tool-call-title')!.textContent).toBe('Thinking…');
  });

  it('thinking shows "Thought" when completed', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'think-2',
      title: '',
      kind: 'think',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Done thinking.' } }],
    });

    const { container } = render(<ToolCallList conversation={conv} />);
    expect(container.querySelector('.tool-call-title')!.textContent).toBe('Thought');
  });

  it('body is collapsed by default for non-thinking tool calls', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-3',
      title: 'Search files',
      kind: 'search',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Found 3 results' } }],
    });

    const { container } = render(<ToolCallList conversation={conv} />);
    const body = container.querySelector('.tool-call-body') as HTMLElement;
    expect(body.hidden).toBe(true);
  });

  it('expands body on header click', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-4',
      title: 'Execute command',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Output here' } }],
    });

    const { container } = render(<ToolCallList conversation={conv} />);
    const header = container.querySelector('.tool-call-header')!;
    const body = container.querySelector('.tool-call-body') as HTMLElement;

    expect(body.hidden).toBe(true);
    fireEvent.click(header);
    expect(body.hidden).toBe(false);
    fireEvent.click(header);
    expect(body.hidden).toBe(true);
  });

  it('renders diff content with old/new text', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-5',
      title: 'Edit file',
      kind: 'edit',
      status: 'completed',
      content: [{
        type: 'diff',
        path: 'src/app.ts',
        oldText: 'const x = 1;',
        newText: 'const x = 2;',
      }],
    });

    const { container } = render(<ToolCallList conversation={conv} />);
    // Expand to see content
    fireEvent.click(container.querySelector('.tool-call-header')!);

    expect(container.textContent).toContain('src/app.ts');
    expect(container.textContent).toContain('const x = 1;');
    expect(container.textContent).toContain('const x = 2;');
  });

  it('renders multiple tool calls', () => {
    const conv = makeConversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-a',
      title: 'First',
      kind: 'read',
      status: 'completed',
    });
    conv.handleSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-b',
      title: 'Second',
      kind: 'edit',
      status: 'pending',
    });

    const { container } = render(<ToolCallList conversation={conv} />);
    const toolCalls = container.querySelectorAll('.tool-call');
    expect(toolCalls.length).toBe(2);
  });

  it('uses correct icon for each kind', () => {
    const conv = makeConversation();
    const kinds = [
      { kind: 'read', icon: '📖' },
      { kind: 'edit', icon: '✏️' },
      { kind: 'execute', icon: '▶️' },
      { kind: 'fetch', icon: '🌐' },
    ] as const;

    for (const { kind, icon } of kinds) {
      conv.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: `tc-${kind}`,
        title: kind,
        kind,
        status: 'completed',
      });
    }

    const { container } = render(<ToolCallList conversation={conv} />);
    const icons = container.querySelectorAll('.kind-icon');
    const iconTexts = [...icons].map(el => el.textContent);

    for (const { icon } of kinds) {
      expect(iconTexts).toContain(icon);
    }
  });
});
