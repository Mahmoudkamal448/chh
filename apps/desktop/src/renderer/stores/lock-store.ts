import { create } from 'zustand';
import type { LockState, SyncStatus } from '@cy-ssh/shared';

interface SecurityState {
  lock: LockState | null;
  sync: SyncStatus | null;
  setLock(l: LockState): void;
  setSync(s: SyncStatus): void;
}

export const useSecurity = create<SecurityState>((set) => ({
  lock: null,
  sync: null,
  setLock: (lock) => set({ lock }),
  setSync: (sync) => set({ sync }),
}));

window.cy.on('lock.changed', (l) => useSecurity.getState().setLock(l));
window.cy.on('sync.state', (s) => useSecurity.getState().setSync(s));
