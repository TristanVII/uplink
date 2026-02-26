import type { SessionInfo } from "../../shared/acp-types";

export async function fetchSessions(cwd: string): Promise<SessionInfo[]> {
  const res = await fetch(
    `/api/sessions?cwd=${encodeURIComponent(cwd)}`,
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions ?? [];
}

export interface SessionListCallbacks {
  onResume: (sessionId: string) => void;
  onNewSession: () => void;
}

export function createSessionListPanel(
  sessions: SessionInfo[],
  supportsResume: boolean,
  callbacks: SessionListCallbacks,
): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "sessions-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Recent Sessions");

  const panel = document.createElement("div");
  panel.className = "sessions-panel";

  // Header
  const header = document.createElement("div");
  header.className = "sessions-panel-header";

  const title = document.createElement("h2");
  title.textContent = "Recent Sessions";

  const closeBtn = document.createElement("button");
  closeBtn.className = "sessions-close-btn";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => overlay.remove());

  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // New Session button
  const newBtn = document.createElement("button");
  newBtn.className = "sessions-new-btn";
  newBtn.type = "button";
  newBtn.textContent = "＋ New Session";
  newBtn.addEventListener("click", () => {
    overlay.remove();
    callbacks.onNewSession();
  });
  panel.appendChild(newBtn);

  // Resume-not-supported note
  if (!supportsResume) {
    const note = document.createElement("p");
    note.className = "sessions-note";
    note.textContent = "Session resume is not supported by this agent.";
    panel.appendChild(note);
  }

  // Session list
  const list = document.createElement("ul");
  list.className = "sessions-list";
  list.setAttribute("role", "list");

  if (sessions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "sessions-empty";
    empty.textContent = "No recent sessions found.";
    list.appendChild(empty);
  } else {
    for (const session of sessions) {
      const card = document.createElement("li");
      card.className = "session-card";
      card.setAttribute("role", "listitem");

      if (supportsResume) {
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.addEventListener("click", () => {
          overlay.remove();
          callbacks.onResume(session.id);
        });
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            overlay.remove();
            callbacks.onResume(session.id);
          }
        });
      } else {
        card.classList.add("disabled");
      }

      const summary = document.createElement("div");
      summary.className = "session-summary";
      const text = session.summary ?? session.id;
      summary.textContent = text.length > 80 ? text.slice(0, 77) + "…" : text;

      const meta = document.createElement("div");
      meta.className = "session-meta";
      const parts: string[] = [];
      if (session.branch) parts.push(session.branch);
      parts.push(formatRelativeTime(session.updatedAt));
      meta.textContent = parts.join(" · ");

      card.appendChild(summary);
      card.appendChild(meta);
      list.appendChild(card);
    }
  }

  panel.appendChild(list);
  overlay.appendChild(panel);

  // Close on backdrop click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Close on Escape
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
    }
  };
  document.addEventListener("keydown", onKeydown);

  return overlay;
}

export function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
