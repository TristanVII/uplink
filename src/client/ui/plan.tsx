import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import type { PlanEntry } from '../../shared/acp-types.js';
import { Conversation } from '../conversation.js';
import { Icon } from './icon.js';

const STATUS_ICONS: Record<PlanEntry['status'], string> = {
  pending: 'pending',
  in_progress: 'sync',
  completed: 'check_circle',
};

function PlanEntryRow({ entry }: { entry: PlanEntry }) {
  const statusClass = entry.status === 'in_progress' ? 'in-progress' : entry.status;
  return (
    <li class={`plan-entry ${statusClass}`}>
      <Icon name={STATUS_ICONS[entry.status]} class="plan-status-icon" />
      <span class="plan-content">{entry.content}</span>
      <span class={`plan-priority priority-${entry.priority}`}>{entry.priority}</span>
    </li>
  );
}

export function PlanCard({ conversation }: { conversation: Conversation }) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    return conversation.onChange(() => setVersion((v) => v + 1));
  }, [conversation]);

  const plan = conversation.plan;
  if (!plan) return null;

  return (
    <div class="plan-card">
      <div class="plan-header"><Icon name="assignment" class="plan-header-icon" /> Plan</div>
      <ul class="plan">
        {plan.entries.map((entry, i) => (
          <PlanEntryRow key={i} entry={entry} />
        ))}
      </ul>
    </div>
  );
}
