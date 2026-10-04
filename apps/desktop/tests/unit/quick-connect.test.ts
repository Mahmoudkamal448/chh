import { describe, expect, it } from 'vitest';
import { parseQuickTarget } from '../../src/renderer/lib/quick-connect';

describe('parseQuickTarget', () => {
  it.each([
    ['web-1', { host: 'web-1', port: 22, username: '' }],
    ['deploy@10.0.0.11', { host: '10.0.0.11', port: 22, username: 'deploy' }],
    ['deploy@10.0.0.11:2222', { host: '10.0.0.11', port: 2222, username: 'deploy' }],
    ['  root@db.internal  ', { host: 'db.internal', port: 22, username: 'root' }],
    ['ssh -p 2200 me@example.com', { host: 'example.com', port: 2200, username: 'me' }],
    ['ssh -i ~/.ssh/id me@example.com', { host: 'example.com', port: 22, username: 'me' }],
    ['ssh://me@example.com:2022/', { host: 'example.com', port: 2022, username: 'me' }],
    ['[2001:db8::1]:2222', { host: '2001:db8::1', port: 2222, username: '' }],
    ['me@2001:db8::1', { host: '2001:db8::1', port: 22, username: 'me' }],
    ['user.name@corp.com@jump.example', { host: 'jump.example', port: 22, username: 'user.name@corp.com' }],
  ])('parses %s', (input, expected) => {
    expect(parseQuickTarget(input)).toEqual(expected);
  });

  it.each(['', '   ', 'host:abc', 'host:70000', 'two words', 'ssh -p 22', 'bad/host'])('rejects %j', (input) => {
    expect(parseQuickTarget(input)).toBeNull();
  });
});
