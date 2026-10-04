// node-pty's macOS prebuilds ship `spawn-helper` without the executable bit when installed through
// pnpm, and every local terminal then fails to start (posix_spawnp). Restore it after install so
// development, tests and packaged apps (electron-builder copies the file as-is) all work.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let root;
try {
  root = dirname(createRequire(join(process.cwd(), 'apps/desktop/package.json')).resolve('node-pty/package.json'));
} catch {
  process.exit(0); // node-pty not installed (e.g. a server-only install)
}

for (const base of [join(root, 'prebuilds'), join(root, 'build', 'Release')]) {
  if (!existsSync(base)) continue;
  const dirs = base.endsWith('prebuilds') ? readdirSync(base).map((d) => join(base, d)) : [base];
  for (const dir of dirs) {
    const helper = join(dir, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      console.log(`made ${helper} executable`);
    }
  }
}
