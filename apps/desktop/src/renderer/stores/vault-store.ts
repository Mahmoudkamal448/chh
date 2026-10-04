import { create } from 'zustand';
import type { Identity, Key } from '@cy-ssh/shared';

/** Keys and identities, shared by the keychain screens and host/group editors. */
interface VaultState {
  keys: Key[];
  identities: Identity[];
  refresh(): Promise<void>;
}

export const useVault = create<VaultState>((set) => ({
  keys: [],
  identities: [],
  async refresh() {
    const [keys, identities] = await Promise.all([window.cy.keys.list({}), window.cy.identities.list({})]);
    set({ keys, identities });
  },
}));
