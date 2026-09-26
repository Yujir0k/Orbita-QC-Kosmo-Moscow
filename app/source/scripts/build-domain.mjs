import { build } from 'vite';
await build({ configFile: false, publicDir: false, logLevel: 'warn', define: { 'import.meta.env.BASE_URL': JSON.stringify('/') },
  build: { target: 'node24', ssr: 'src/domain.ts', outDir: 'server/generated', emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'domain.mjs' } } } });

await build({ configFile: false, publicDir: false, logLevel: 'warn', build: { target: 'node24', ssr: 'src/managerMockData.ts', outDir: 'server/generated', emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'executive.mjs' } } } });
