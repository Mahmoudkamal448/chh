import { randomUUID } from 'node:crypto';
import type { CloudCandidate } from '@chh/shared';
import type { GroupsRepo } from '../db/groups-repo';
import type { HostsRepo } from '../db/hosts-repo';
import { AppError } from '../ipc/handle';

const TTL_MS = 15 * 60_000;

/** Stages provider results in main (the renderer only sends back ids) and imports/updates hosts. */
export class CloudImporter {
  private readonly staged = new Map<string, { candidates: CloudCandidate[]; expires: number }>();

  constructor(
    private readonly hosts: HostsRepo,
    private readonly groups: GroupsRepo,
  ) {}

  stage(list: Array<Omit<CloudCandidate, 'exists'>>): { token: string; candidates: CloudCandidate[] } {
    const known = this.hosts.byExternalId();
    const candidates = list.map((c) => ({ ...c, exists: known.has(c.externalId) }));
    const now = Date.now();
    for (const [k, v] of this.staged) if (v.expires < now) this.staged.delete(k);
    const token = randomUUID();
    this.staged.set(token, { candidates, expires: now + TTL_MS });
    return { token, candidates };
  }

  import(opts: { token: string; externalIds: string[]; groupLabel?: string; username?: string; address: 'public' | 'private' | 'dns' }): { created: number; updated: number } {
    const stage = this.staged.get(opts.token);
    if (!stage) throw new AppError('expired', 'cloud.error.expired');
    const wanted = new Set(opts.externalIds);
    const known = this.hosts.byExternalId();
    let groupId: string | null = null;
    if (opts.groupLabel) {
      groupId = this.groups.list().find((g) => g.label === opts.groupLabel && !g.parentId)?.id ?? this.groups.create({ label: opts.groupLabel }).id;
    }
    let created = 0;
    let updated = 0;
    for (const c of stage.candidates) {
      if (!wanted.has(c.externalId)) continue;
      const address =
        (opts.address === 'private' ? c.privateAddress : opts.address === 'dns' ? c.publicDns : c.publicAddress) ?? c.publicAddress ?? c.privateAddress;
      if (!address) continue; // no reachable address at all
      const existing = known.get(c.externalId);
      if (existing) {
        // Re-import refreshes what the cloud owns (IPs change on stop/start) but keeps user settings.
        this.hosts.updateFromCloud(existing, { label: c.name, address, tags: c.tags, osHint: c.osHint });
        updated++;
      } else {
        const user = opts.username || c.user;
        const h = this.hosts.create({
          label: c.name,
          address,
          groupId,
          tags: c.tags,
          externalId: c.externalId,
          notes: `Imported from ${c.externalId.startsWith('aws:') ? `AWS ${c.region}` : `DigitalOcean ${c.region}`}`,
          settings: user ? { username: user } : {},
        });
        if (c.osHint) this.hosts.setOsHint(h.id, c.osHint);
        created++;
      }
    }
    return { created, updated };
  }
}
