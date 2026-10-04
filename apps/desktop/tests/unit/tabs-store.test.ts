import { beforeEach, describe, expect, it } from 'vitest';

// The store talks to the preload API; give it just what opening a host needs.
let onOpen: (sessionId: string) => void = () => undefined;
(globalThis as unknown as { window: unknown }).window = {
  chh: {
    sessions: {
      openHost: async () => {
        onOpen('s1');
        return { sessionId: 's1' };
      },
      close: async () => undefined,
    },
  },
};
const { useTabs } = await import('../../src/renderer/stores/tabs-store');

describe('tabs store', () => {
  beforeEach(() => useTabs.setState({ tabs: [], panes: {} }));

  it('keeps a status that arrives before the pane exists (a session failing right away)', async () => {
    onOpen = (id) => {
      useTabs.getState().setStatus(id, 'error', 'session.error.noCertificate::web-1');
      useTabs.getState().setStatus(id, 'closed'); // the failed session is closed right after
    };
    await useTabs.getState().openHost('h1', 'web-1');
    const pane = Object.values(useTabs.getState().panes)[0]!;
    expect(pane).toMatchObject({ sessionId: 's1', status: 'error', message: 'session.error.noCertificate::web-1' });
  });

  it('does not let "closed" replace an error', async () => {
    onOpen = () => undefined;
    await useTabs.getState().openHost('h1', 'web-1');
    useTabs.getState().setStatus('s1', 'error', 'session.error.refused');
    useTabs.getState().setStatus('s1', 'closed');
    expect(Object.values(useTabs.getState().panes)[0]).toMatchObject({ status: 'error', message: 'session.error.refused' });
  });
});
