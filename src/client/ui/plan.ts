import type { PlanEntry } from '../../shared/acp-types.js';
import { Conversation } from '../conversation.js';

const STATUS_ICONS: Record<PlanEntry['status'], string> = {
  pending: '⏳',
  in_progress: '🔄',
  completed: '✅',
};

export class PlanUI {
  private chatArea: HTMLElement;
  private conversation: Conversation;
  private unsubscribe: (() => void) | null = null;
  private container: HTMLElement | null = null;

  constructor(chatArea: HTMLElement, conversation: Conversation) {
    this.chatArea = chatArea;
    this.conversation = conversation;
  }

  attach(): void {
    this.unsubscribe = this.conversation.onChange(() => this.render());
    this.render();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private render(): void {
    const plan = this.conversation.plan;

    if (!plan) {
      this.container?.remove();
      this.container = null;
      return;
    }

    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'plan-card';
      this.chatArea.appendChild(this.container);
    }

    this.container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'plan-header';
    header.textContent = '📋 Plan';
    this.container.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'plan';

    for (const entry of plan.entries) {
      list.appendChild(this.renderEntry(entry));
    }

    this.container.appendChild(list);
  }

  private renderEntry(entry: PlanEntry): HTMLElement {
    const li = document.createElement('li');
    const statusClass = entry.status === 'in_progress' ? 'in-progress' : entry.status;
    li.className = `plan-entry ${statusClass}`;

    const icon = document.createElement('span');
    icon.className = 'plan-status-icon';
    icon.textContent = STATUS_ICONS[entry.status];
    li.appendChild(icon);

    const content = document.createElement('span');
    content.className = 'plan-content';
    content.textContent = entry.content;
    li.appendChild(content);

    const priority = document.createElement('span');
    priority.className = `plan-priority priority-${entry.priority}`;
    priority.textContent = entry.priority;
    li.appendChild(priority);

    return li;
  }
}
