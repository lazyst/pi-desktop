// Vitest 桩：替掉真实 monaco 包（其 exports 映射在纯 vitest 环境无法被 Vite 解析）。
// 仅用于单测；electron-vite 生产构建仍用真实 monaco（见 components/editor/monaco-setup.ts）。
const noop = () => {};

export const editor = {
  setTheme: noop,
  create: () => ({}),
  defineTheme: noop,
};

export const languages = {
  typescript: { typescriptDefaults: {}, javascriptDefaults: {} },
};

export default {
  editor,
  languages,
  Uri: { parse: (s: string) => ({ toString: () => s }) },
};
