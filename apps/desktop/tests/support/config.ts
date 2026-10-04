import type { SshConnectConfig } from '../../src/session-host/protocol';

/** A complete connection config for the test SSH server (user "tester"). */
export function sshConfig(port: number, over: Partial<SshConnectConfig> = {}): SshConnectConfig {
  return {
    host: '127.0.0.1',
    port,
    username: 'tester',
    password: null,
    privateKey: null,
    useAgent: false,
    tryDefaultKeys: false,
    keepAliveSec: 0,
    connectTimeoutSec: 10,
    label: `test:${port}`,
    agent: '',
    agentForward: false,
    jumps: [],
    proxy: null,
    env: {},
    envMethod: 'request',
    ...over,
  };
}
