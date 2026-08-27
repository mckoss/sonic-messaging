import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import packageJson from './package.json';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/sonic-messaging/' : '/',
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  plugins: [svelte()],
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
