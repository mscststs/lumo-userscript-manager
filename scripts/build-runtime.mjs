import path from 'node:path';
import { build } from 'vite';

const root = process.cwd();
const entries = [
  { entry: 'lib/runtime/runner.ts', name: 'LumoRunner', file: 'runner.js' },
  { entry: 'lib/runtime/host.ts', name: 'LumoHost', file: 'host.js' },
];

for (const item of entries) {
  await build({
    configFile: false,
    root,
    publicDir: false,
    resolve: {
      alias: { '@': root },
    },
    build: {
      outDir: path.join(root, 'public/user-scripts'),
      emptyOutDir: false,
      write: true,
      minify: false,
      lib: {
        entry: path.join(root, item.entry),
        formats: ['iife'],
        name: item.name,
        fileName: () => item.file,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          extend: true,
        },
      },
    },
    logLevel: 'warn',
  });
}
