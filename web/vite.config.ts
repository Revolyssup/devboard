import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.DEVBOARD_API || 'http://localhost:5178';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      // ws:true so the terminal socket survives the dev proxy — without it the feature works
      // at :5178 (what `npm run verify` hits) and silently fails at :5177.
      '/api': { target: API, changeOrigin: true, ws: true },
      '/reports': { target: API, changeOrigin: true },
    },
  },
});
