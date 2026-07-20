// Vitest 桩：替掉 @monaco-editor/react（依赖真实 monaco 包，纯 vitest 环境无法解析）。
// 业务组件在单测中若未整体 mock（如 App 集成测试渲染到 PreviewTab），
// 用本桩渲染一个空 div，避免拉起重 monaco 依赖。
import { forwardRef } from 'react';

export const Editor = forwardRef<unknown, any>(function Editor(_props, _ref) {
  return null;
});

export const loader = { config: () => {} };

export type OnMount = (editor: unknown, monaco: unknown) => void;
export type OnChange = (value: string | undefined) => void;
