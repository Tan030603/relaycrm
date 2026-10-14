import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Same-origin /api in dev (proxied to the API), so no CORS setup is needed.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5180,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
