import { create } from 'zustand';
import type { MyInvite, TeamSummary, VaultSummary } from '@chh/shared';

/** Teams this account belongs to, invites to it, and the vaults items can live in. */
interface TeamsState {
  teams: TeamSummary[];
  invites: MyInvite[];
  myFingerprint: string | null;
  vaults: VaultSummary[];
  loading: boolean;
  /** Last refresh failed (i18n key), e.g. offline. */
  error: string | null;
  refresh(): Promise<void>;
  refreshVaults(): Promise<void>;
}

export const useTeams = create<TeamsState>((set) => ({
  teams: [],
  invites: [],
  myFingerprint: null,
  vaults: [],
  loading: false,
  error: null,
  async refresh() {
    set({ loading: true });
    try {
      const [list, vaults] = await Promise.all([window.chh.teams.list({}), window.chh.teams.vaults({})]);
      set({ ...list, vaults, error: null });
    } catch (err) {
      const { errorKey } = await import('../lib/errors');
      set({ error: errorKey(err), vaults: await window.chh.teams.vaults({}).catch(() => []) });
    } finally {
      set({ loading: false });
    }
  },
  async refreshVaults() {
    set({ vaults: await window.chh.teams.vaults({}) });
  },
}));

/** Team vault name for an item's vault, or null for the personal vault. */
export function useTeamVaultName(vaultId: string | undefined): string | null {
  return useTeams((s) => {
    const v = vaultId ? s.vaults.find((x) => x.id === vaultId) : undefined;
    return v && v.kind === 'team' ? v.name : null;
  });
}
