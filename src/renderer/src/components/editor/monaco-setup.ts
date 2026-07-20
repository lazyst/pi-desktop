// Monaco 本地化集成骨架（非 CDN）。
// 参考 orca `lib/monaco-setup.ts`，但为 pi 的最小骨架：仅建立本地打包与
// worker 分发、关掉 TS/JS 校验、开 jsx: Preserve，挂载 loader 本地实例。
// 暂不引入任何业务装饰（astro/vue/svelte 语言、context-menu paste 等），
// 也不被任何业务组件引用——本文件只作为阶段3 Monaco 编辑器的接入点。
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

const { typescript: monacoTS } = monaco.languages;

// 按 language label 分发 worker，避免走 CDN loader。
// 注意：monaco 的 `editor.api.d.ts` 用 `declare global { let MonacoEnvironment }`
// 声明（let 不挂到 globalThis 类型上），故直接赋值给全局变量而非 globalThis 属性。
MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Why: Monaco 在 pi 中是预览/阅读表面而非 IDE——用户在自己 IDE 里改真实代码。
// 沙箱 TS worker 无法解析工程内 import，语义/语法校验会产生大量 false positive
// （未解析模块、未用 import 灰显、缺失名等）。关掉三类诊断，只保留着色（tokenization），
// 这才是阅读场景真正有用的能力。
const diagnosticsOptions: monaco.languages.typescript.DiagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true,
};
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);

// Why: .tsx/.jsx 在 Monaco 注册表里复用 'typescript'/'javascript' 语言 id（没有
// 独立的 'typescriptreact' id），故这两个 defaults 的 compilerOptions 对二者通用。
// 不开 jsx，worker 会对每个 JSX 标签报 TS17004 "Cannot use JSX unless the
// '--jsx' flag is provided"。Preserve 模式足以解析，且不强制 emit（pi 从不 emit）。
monacoTS.typescriptDefaults.setCompilerOptions({
  ...monacoTS.typescriptDefaults.getCompilerOptions(),
  jsx: monaco.languages.typescript.JsxEmit.Preserve,
});
monacoTS.javascriptDefaults.setCompilerOptions({
  ...monacoTS.javascriptDefaults.getCompilerOptions(),
  jsx: monaco.languages.typescript.JsxEmit.Preserve,
});

// 配置 Monaco 使用本地打包的编辑器，而非 CDN。
loader.config({ monaco });

// 便于后续组件直接 import 已配置好的 monaco 实例。
export { monaco };
