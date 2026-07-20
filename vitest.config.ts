import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src/renderer/src', import.meta.url).pathname,
      // 纯 vitest 环境无法解析 monaco 的 exports 映射，用桩替代（生产构建仍用真实包）。
      'monaco-editor': new URL('./src/renderer/src/__tests__/monaco-stub.ts', import.meta.url).pathname,
      '@monaco-editor/react': new URL('./src/renderer/src/__tests__/monaco-react-stub.tsx', import.meta.url).pathname,
      // monaco-setup 会 import monaco CSS 与 ?worker，单测用桩替掉（仅 MonacoCodeEditor 引用）。
      './monaco-setup': new URL('./src/renderer/src/__tests__/monaco-setup-stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/renderer/src/__tests__/setup.ts'],
    css: true,
  },
});
