import {
  GenerateKeyInputSchema,
  KeyFieldsSchema,
  type GenerateKeyInput,
  type GroupFields,
  type HostFields,
  type IdentityFields,
  type ImportKeyResult,
  type CertificateSummary,
  type Key,
  type KeyFields,
} from '@chh/shared';
import {
  KeyFormatError,
  fingerprint,
  generateKey,
  parseCertificate,
  parsePrivateKey,
  parsePublicKeyLine,
  publicKeyLine,
  writeOpenSshPrivate,
  type PrivateKey,
} from '@chh/key-formats';
import type { LocalVault } from '../vault/local-vault';
import { NotFoundError } from './hosts-repo';
import { uuidv7, type ItemStore, type StoredItem } from './item-store';

const PRIVATE_FIELD = 'privateKey';

export class KeysRepo {
  constructor(
    private readonly store: ItemStore,
    private readonly vault: LocalVault,
  ) {}

  list(): Key[] {
    return this.store.query<KeyFields>('key').map(toKey);
  }

  get(id: string): Key {
    return toKey(this.getStored(id));
  }

  generate(input: GenerateKeyInput): Key {
    const data = GenerateKeyInputSchema.parse(input);
    const spec = data.algorithm === 'ed25519' ? { algorithm: 'ed25519' as const } : { algorithm: data.algorithm, bits: data.bits };
    const key = generateKey(spec as Parameters<typeof generateKey>[0], data.comment);
    return this.save(key, data.label, 'generated');
  }

  /**
   * Parses, decrypts and stores a key. Passphrase problems are returned, not thrown. A certificate found
   * next to the key file is attached if it belongs to it (and to an existing key without one).
   */
  async importText(text: string, label?: string, passphrase?: string, certificate?: string): Promise<ImportKeyResult> {
    let key: PrivateKey;
    try {
      key = await parsePrivateKey(text, passphrase || undefined);
    } catch (err) {
      if (err instanceof KeyFormatError && (err.code === 'passphrase_required' || err.code === 'bad_passphrase')) {
        return { status: err.code };
      }
      throw err;
    }
    const fp = fingerprint(key.publicBlob);
    const cert = certificate && certificateFor(certificate, key.publicBlob) ? certificate.trim() : null;
    const existing = this.list().find((k) => k.fingerprint === fp);
    if (existing) {
      if (cert && !existing.certificate) return { status: 'duplicate', existing: this.setCertificate(existing.id, cert) };
      return { status: 'duplicate', existing };
    }
    const name = label?.trim() || key.comment || fp.slice(7, 19);
    return { status: 'imported', key: this.save(key, name, key.sourceFormat, cert) };
  }

  /**
   * Attaches an OpenSSH user certificate to a key (null removes it). Throws KeyFormatError when it isn't a
   * certificate, is a host certificate, or certifies a different key.
   */
  setCertificate(id: string, certificate: string | null): Key {
    const item = this.getStored(id);
    let value: string | null = null;
    if (certificate !== null && certificate.trim()) {
      const info = parseCertificate(certificate);
      if (info.kind !== 'user') throw new KeyFormatError('cert_host');
      if (!info.publicBlob.equals(parsePublicKeyLine(item.fields.publicKey).publicBlob)) throw new KeyFormatError('cert_mismatch');
      value = certificate.trim();
    }
    const updated = this.store.update<KeyFields>(id, 'key', { certificate: value });
    if (!updated) throw new NotFoundError();
    return toKey(updated);
  }

  /** The key's certificate line, if any (for connecting). */
  getCertificate(id: string): string | null {
    return this.getStored(id).fields.certificate ?? null;
  }

  rename(id: string, label: string): Key {
    const updated = this.store.update<KeyFields>(id, 'key', { label });
    if (!updated) throw new NotFoundError();
    return toKey(updated);
  }

  /** Deletes keys and clears every reference to them (hosts, groups, identities). */
  remove(ids: string[]): void {
    const gone = new Set(ids);
    this.store.transaction(() => {
      for (const type of ['host', 'group'] as const) {
        for (const item of this.store.query<HostFields | GroupFields>(type, `json_extract(fields, '$.settings.keyId') IS NOT NULL`)) {
          if (gone.has(item.fields.settings.keyId ?? '')) {
            this.store.update(item.id, type, { settings: { ...item.fields.settings, keyId: undefined } });
          }
        }
      }
      for (const ident of this.store.query<IdentityFields>('identity')) {
        if (ident.fields.keyId && gone.has(ident.fields.keyId)) this.store.update<IdentityFields>(ident.id, 'identity', { keyId: null });
      }
      for (const id of ids) this.store.remove(id, 'key');
    });
  }

  /** Labels of everything that uses this key. */
  usage(id: string): string[] {
    const out: string[] = [];
    for (const type of ['host', 'group'] as const) {
      for (const item of this.store.query<HostFields | GroupFields>(type, `json_extract(fields, '$.settings.keyId') = ?`, [id])) out.push(item.fields.label);
    }
    for (const ident of this.store.query<IdentityFields>('identity', `json_extract(fields, '$.keyId') = ?`, [id])) out.push(ident.fields.label);
    return out;
  }

  /** Main-process only: the decrypted OpenSSH private key for connecting or exporting. */
  getPrivate(id: string): string {
    const item = this.getStored(id);
    return this.vault.open(item.fields.privateKey, { itemId: id, field: PRIVATE_FIELD, vaultId: item.vaultId });
  }

  /** OpenSSH-format export, re-encrypted with `passphrase` if given. */
  async exportPrivate(id: string, passphrase?: string): Promise<string> {
    const plain = this.getPrivate(id);
    if (!passphrase) return plain;
    const key = await parsePrivateKey(plain);
    return writeOpenSshPrivate(key, passphrase);
  }

  private save(key: PrivateKey, label: string, origin: KeyFields['origin'], certificate: string | null = null): Key {
    const id = uuidv7();
    const fields = KeyFieldsSchema.parse({
      label: label.slice(0, 200),
      type: key.type,
      bits: key.bits,
      publicKey: publicKeyLine(key),
      fingerprint: fingerprint(key.publicBlob),
      comment: key.comment,
      privateKey: this.vault.seal(writeOpenSshPrivate(key), { itemId: id, field: PRIVATE_FIELD }),
      origin,
      createdAt: Date.now(),
      certificate,
    });
    return toKey(this.store.insert('key', fields, id));
  }

  private getStored(id: string): StoredItem<KeyFields> {
    const item = this.store.get<KeyFields>(id, 'key');
    if (!item) throw new NotFoundError();
    return item;
  }
}

function toKey(item: StoredItem<KeyFields>): Key {
  const { privateKey: _secret, certificate, ...rest } = item.fields;
  return { ...rest, id: item.id, vaultId: item.vaultId, updatedAt: item.updatedAt, certificate: summarize(certificate ?? null) };
}

function summarize(certificate: string | null): CertificateSummary | null {
  if (!certificate) return null;
  try {
    const { certType, kind, serial, keyId, principals, validAfter, validBefore, extensions, criticalOptions, caFingerprint } = parseCertificate(certificate);
    return { certType, kind, serial, keyId, principals, validAfter, validBefore, extensions, criticalOptions, caFingerprint };
  } catch {
    return null; // stored by a newer version in a format this one can't read
  }
}

/** True if `certificate` is a user certificate for the key with this public blob. */
function certificateFor(certificate: string, publicBlob: Buffer): boolean {
  try {
    const info = parseCertificate(certificate);
    return info.kind === 'user' && info.publicBlob.equals(publicBlob);
  } catch {
    return false;
  }
}
