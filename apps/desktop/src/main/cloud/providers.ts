import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DescribeInstancesCommand, EC2Client, type Instance } from '@aws-sdk/client-ec2';
import { fromIni } from '@aws-sdk/credential-providers';
import type { CloudCandidate } from '@chh/shared';

type Candidate = Omit<CloudCandidate, 'exists'>;

/** Test hooks: point the SDKs at local fake APIs. */
const AWS_ENDPOINT = process.env.CHH_TEST === '1' ? process.env.CHH_AWS_ENDPOINT : undefined;
const DO_ENDPOINT = (process.env.CHH_TEST === '1' && process.env.CHH_DO_ENDPOINT) || 'https://api.digitalocean.com';

/** Profile names from ~/.aws/credentials and ~/.aws/config. */
export function awsProfiles(): string[] {
  const out = new Set<string>();
  for (const [file, isConfig] of [
    [process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'), false],
    [process.env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'), true],
  ] as const) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s*\[\s*(?:profile\s+)?([^\]\s]+)\s*\]/gm)) if (!isConfig || m[0].includes('profile') || m[1] === 'default') out.add(m[1]!);
  }
  return [...out].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
}

function osFromAws(i: Instance): string | null {
  if (/windows/i.test(`${i.Platform ?? ''} ${i.PlatformDetails ?? ''}`)) return 'windows';
  if (/red hat/i.test(i.PlatformDetails ?? '')) return 'rhel';
  if (/suse/i.test(i.PlatformDetails ?? '')) return 'suse';
  if (/ubuntu/i.test(i.PlatformDetails ?? '')) return 'ubuntu';
  return null;
}

export async function listAws(input: {
  regions: string[];
  profile?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}): Promise<Candidate[]> {
  const credentials = input.accessKeyId
    ? { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey ?? '', sessionToken: input.sessionToken }
    : input.profile
      ? fromIni({ profile: input.profile })
      : undefined; // SDK default chain (env, SSO, ~/.aws, instance role…)
  const out: Candidate[] = [];
  for (const region of input.regions) {
    const ec2 = new EC2Client({ region, credentials, ...(AWS_ENDPOINT ? { endpoint: AWS_ENDPOINT } : {}), maxAttempts: 2 });
    let NextToken: string | undefined;
    do {
      const res = await ec2.send(
        new DescribeInstancesCommand({ NextToken, MaxResults: 1000, Filters: [{ Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }),
      );
      for (const r of res.Reservations ?? []) {
        for (const i of r.Instances ?? []) {
          if (!i.InstanceId) continue;
          const name = i.Tags?.find((t) => t.Key === 'Name')?.Value;
          out.push({
            externalId: `aws:${i.InstanceId}`,
            name: name || i.InstanceId,
            publicAddress: i.PublicIpAddress ?? null,
            privateAddress: i.PrivateIpAddress ?? null,
            publicDns: i.PublicDnsName || null,
            region,
            tags: ['aws', region, ...(i.InstanceType ? [i.InstanceType] : [])],
            osHint: osFromAws(i),
            user: null,
          });
        }
      }
      NextToken = res.NextToken;
    } while (NextToken);
    ec2.destroy();
  }
  return out;
}

interface Droplet {
  id: number;
  name: string;
  region?: { slug?: string };
  tags?: string[];
  image?: { distribution?: string };
  networks?: { v4?: Array<{ ip_address: string; type: 'public' | 'private' }> };
}

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function listDigitalOcean(apiToken: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let page = 1; page < 100; page++) {
    const res = await fetch(`${DO_ENDPOINT}/v2/droplets?per_page=200&page=${page}`, {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new CloudApiError(res.status, `DigitalOcean API: HTTP ${res.status}`);
    const data = (await res.json()) as { droplets: Droplet[]; links?: { pages?: { next?: string } } };
    for (const d of data.droplets ?? []) {
      const v4 = d.networks?.v4 ?? [];
      const distro = d.image?.distribution?.toLowerCase() ?? null;
      out.push({
        externalId: `do:${d.id}`,
        name: d.name,
        publicAddress: v4.find((n) => n.type === 'public')?.ip_address ?? null,
        privateAddress: v4.find((n) => n.type === 'private')?.ip_address ?? null,
        publicDns: null,
        region: d.region?.slug ?? '',
        tags: ['digitalocean', ...(d.region?.slug ? [d.region.slug] : []), ...(d.tags ?? [])],
        osHint: distro,
        user: 'root',
      });
    }
    if (!data.links?.pages?.next) break;
  }
  return out;
}
