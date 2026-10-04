import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST_SETTINGS, groupChain, resolveSettings, type GroupLike } from '../src';

const g = (id: string, parentId: string | null, settings: GroupLike['settings']): [string, GroupLike] => [id, { id, parentId, settings }];

describe('settings inheritance', () => {
  const groups = new Map<string, GroupLike>([
    g('root', null, { username: 'ops', fontSize: 12, port: 2200 }),
    g('mid', 'root', { username: 'deploy' }),
    g('leaf', 'mid', { terminalTheme: 'moss' }),
  ]);

  it('resolves defaults ← root … leaf ← host', () => {
    const s = resolveSettings('leaf', { port: 22 }, groups);
    expect(s).toMatchObject({ username: 'deploy', fontSize: 12, port: 22, terminalTheme: 'moss' });
    expect(s.scrollback).toBe(DEFAULT_HOST_SETTINGS.scrollback);
  });

  it('ignores undefined overrides instead of clobbering inherited values', () => {
    expect(resolveSettings('leaf', { username: undefined }, groups).username).toBe('deploy');
  });

  it('handles no group, dangling parents and cycles', () => {
    expect(resolveSettings(null, {}, groups)).toEqual(DEFAULT_HOST_SETTINGS);
    expect(groupChain('missing', groups)).toEqual([]);
    const cyclic = new Map<string, GroupLike>([g('a', 'b', { username: 'a' }), g('b', 'a', { username: 'b' })]);
    expect(groupChain('a', cyclic).map((x) => x.id)).toEqual(['b', 'a']);
    expect(resolveSettings('a', {}, cyclic).username).toBe('a');
  });
});
