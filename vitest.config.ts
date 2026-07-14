import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': new URL('./src/renderer/src', import.meta.url).pathname } },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/renderer/src/__tests__/setup.ts'],
    css: true,
  },
});
