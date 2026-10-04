// Bundles the server into dist/index.js. Workspace packages (TypeScript source) are inlined;
// npm dependencies stay external and are installed in the Docker image.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [
    {
      name: 'externalize-npm',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@chh/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
