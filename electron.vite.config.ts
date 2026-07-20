import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { build: { rollupOptions: { external: ['node-pty'] } } },
  preload: { build: { rollupOptions: { external: ['node-pty'] } } },
  renderer: {
    resolve: { alias: { '@': '/src/renderer/src' } },
    plugins: [react()],
    // Monaco worker 以 `?worker` 导入，需以 ES module 格式产出，
    // 否则 electron 渲染进程加载 worker 时会因格式不匹配报错。
    worker: {
      format: 'es',
    },
  },
});
