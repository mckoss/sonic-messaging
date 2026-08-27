import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/sonic-messaging/' : '/',
  plugins: [svelte()],
  worker: { format: 'es' },
  test: { environment: 'node' }
});
