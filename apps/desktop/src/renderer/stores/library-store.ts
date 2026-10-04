import { create } from 'zustand';
import type { Forward, ForwardStatus, Snippet } from '@cy-ssh/shared';

/** Snippets and port-forwarding rules + their live status. */
interface LibraryState {
  snippets: Snippet[];
  forwards: Forward[];
  forwardStatus: Record<string, ForwardStatus>;
  refreshSnippets(): Promise<void>;
  refreshForwards(): Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  snippets: [],
  forwards: [],
  forwardStatus: {},
  async refreshSnippets() {
    set({ snippets: await window.cy.snippets.list({}) });
  },
  async refreshForwards() {
    const [forwards, statuses] = await Promise.all([window.cy.forwards.list({}), window.cy.forwards.statuses({})]);
    set({ forwards, forwardStatus: Object.fromEntries(statuses.map((s) => [s.id, s])) });
  },
}));

window.cy.on('forward.update', (s) => {
  const next = { ...useLibrary.getState().forwardStatus };
  if (s.state === 'stopped') delete next[s.id];
  else next[s.id] = s;
  useLibrary.setState({ forwardStatus: next });
});
