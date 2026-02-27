import { h } from 'preact';

/** Renders a Material Symbols Outlined icon. */
export function Icon({ name, class: cls }: { name: string; class?: string }) {
  return (
    <span class={`material-symbols-outlined${cls ? ` ${cls}` : ''}`}>{name}</span>
  );
}
