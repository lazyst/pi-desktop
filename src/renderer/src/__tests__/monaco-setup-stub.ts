// Vitest 桩：替掉 components/editor/monaco-setup（真实版会 import monaco CSS 与
// ?worker，纯 vitest 环境无法解析）。仅导出 MonacoCodeEditor 用到的 `monaco` 实例。
import { editor, languages } from './monaco-stub';

export const monaco = { editor, languages };
