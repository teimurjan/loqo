/**
 * Three bundles, because they run in three places: the plugin and the codec on the server (one
 * graph, split), the admin components in the browser (`'use client'`, which the bundler hoists
 * imports above — so it is put back first), and the server-rendered view, which reaches the client
 * bundle through the package boundary. Declarations come from `tsc`.
 */
import { $ } from 'bun';

const common = { format: 'esm', packages: 'external', outdir: 'dist', define: { 'process.env.NODE_ENV': '"production"' } } as const;

const check = (result: Awaited<ReturnType<typeof Bun.build>>) => {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};

await $`rm -rf dist`;
check(await Bun.build({ ...common, entrypoints: ['src/index.ts', 'src/lexical.ts'], target: 'node', splitting: true }));
check(await Bun.build({ ...common, entrypoints: ['src/rsc.tsx'], target: 'node' }));
check(await Bun.build({ ...common, entrypoints: ['src/client.tsx'], target: 'browser' }));

const client = Bun.file('dist/client.js');
await Bun.write(client, `'use client';\n${(await client.text()).replace(/^"use client";\n/m, '')}`);

await $`tsc -p tsconfig.build.json`;
