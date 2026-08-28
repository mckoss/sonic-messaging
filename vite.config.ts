import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import packageJson from './package.json';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/sonic-messaging/' : '/',
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  server: { host: true },
  plugins: [svelte(), basicSsl()],
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
