import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTeamVaultName } from '../../stores/teams-store';

/** Shows which team an item is shared with (nothing for personal items). */
export function VaultBadge({ vaultId }: { vaultId: string | undefined }) {
  const { t } = useTranslation();
  const name = useTeamVaultName(vaultId);
  if (name === null) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent"
      title={t('teams.sharedWith', { name })}
      data-testid="vault-badge"
    >
      <Users size={11} aria-hidden />
      {name || t('teams.unnamed')}
    </span>
  );
}
