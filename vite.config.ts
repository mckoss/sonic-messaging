import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import packageJson from './package.json';

// HTTPS only in dev: phones need a secure context for getUserMedia, while
// Playwright drives the preview server over plain HTTP.
export default defineConfig(({ mode }) => ({
  base: process.env.GITHUB_ACTIONS ? '/sonic-messaging/' : '/',
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  server: { host: true },
  plugins: mode === 'development' ? [svelte(), basicSsl()] : [svelte()],
  worker: { format: 'es' as const },
  test: {
    include: ['src/**/*.test.ts'], environment: 'node',
    // The DSP tests synthesize whole conversations at the production sample rate and decode them — coded control
    // frames by soft Viterbi — and a CI runner is several times slower than a laptop: 6.6 s there against the 5 s default.
    testTimeout: 30_000
  }
}));
