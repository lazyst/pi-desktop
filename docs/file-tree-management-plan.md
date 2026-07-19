# 文件树文件管理功能 — 实施计划

> 来源：经 `/grilling` 会话敲定的需求与决策。
> 目标：为文件树（FileTree）补齐「新建 / 重命名 / 删除 / 移动 / 复制粘贴 / 多选 / 拖拽到终端」等文件管理功能。

---

## 一、已锁定的决策（烤问结论）

- [x] **安全模型**：完全移除（路线 X）。`resolveSafe` / `FsSecurityError` 一并删除，不留半残；所有 fs 操作直接信任 `root + relPath`。
- [x] **功能范围**：新建文件、新建目录、重命名、删除、跨目录拖拽移动、复制/剪切/粘贴、Ctrl+多选、拖拽到终端转多路径。
- [x] **新建落盘**：C2 方案——先建纯 UI 伪节点，输完名回车才真正落盘（`fs:createFile`）。
- [x] **重命名**：inline 原地编辑；重名自动加 `(1)` 后缀（主进程 `listNames` 计算）。
- [x] **删除入口**：右键菜单 → 「删除」。
- [x] **删除确认**：目录 / 多选删除弹 `ConfirmDialog`（显示「将删除 X 个项目」）；单文件不弹。
- [x] **撤销**：一期不做。
- [x] **剪切视觉**：源节点半透明置灰（`.cut-pending`）。
- [x] **复制粘贴**：一期用应用内内存剪贴板（module 级单例），不做系统剪贴板桥接。
- [x] **多选拖拽语义**：拖什么带什么；若拖的是已选中项之一，则携带整个选中集。
- [x] **菜单入口**：只靠右键菜单，顶部不加按钮。
- [x] **刷新策略**：局部刷新受影响的目录节点（而非整树 `treeRefreshKey++` 重拉），避免收起已展开目录。

---

## 二、接口契约（待实现）

### 主进程 `src/main/fsBridge.ts`
移除：`resolveSafe` / `FsSecurityError` / 内部 `normalize` 越权逻辑。
现有 `listDir` / `readFile` / `writeFile` / `statFile` 改为直接 `path.resolve(root, relPath)`。

新增：
```ts
mkdir(root, relDir): Promise<void>                 // fs.mkdir(recursive)
createFile(root, relPath, content=''): Promise<void>
rename(root, fromRel, toRel): Promise<void>        // fs.rename，天然支持移动
remove(root, relPath): Promise<void>               // 文件 rm；目录 rm -rf
copy(root, fromRel, toRel): Promise<void>          // 文件 copyFile；目录递归 copy
listNames(root, dir): Promise<string[]>            // 返回子项名数组（供去重/后缀）
```

### 主进程 `src/main/index.ts`
注册新 handler（同时把现有 4 个 fs handler 的 `resolveSafe` 调用改掉）：
```
fs:mkdir      { root, dir }
fs:createFile { root, path }
fs:rename     { root, from, to }
fs:remove     { root, path }
fs:copy       { root, from, to }
fs:listNames  { root, dir }
```

### 渲染端 `src/renderer/src/ipc.ts`（`PiApi` 接口）
新增：`fsMkdir` / `fsCreateFile` / `fsRename` / `fsRemove` / `fsCopy` / `fsListNames`。

### 新增 `src/renderer/src/lib/clipboard.ts`
```ts
type ClipItem = { root: string; relPath: string; isDir: boolean };
type ClipState = { mode: 'copy' | 'cut'; items: ClipItem[] };
export const clipboard: {
  get(): ClipState | null;
  set(s: ClipState | null): void;
  clear(): void;
  subscribe(cb): () => void;
};
```

### 右键菜单项全集（复用现有 `ContextMenu.tsx`）
- 目录右键：新建文件 / 新建目录 / 剪切 / 复制 / 粘贴（剪贴板有内容时）/ 重命名 / 删除
- 文件右键：剪切 / 复制 / 重命名 / 删除
- 空白区域右键：新建文件 / 新建目录 / 粘贴（剪贴板有内容时）

### `FileTree.tsx` 状态提升（FileTree 组件）
- `selection: Set<string>`（Ctrl+点击切换；普通点击清空并选中+打开）
- `editing: { relPath; isDir; isNew } | null`（inline 编辑态，C2 伪节点）
- `menu: { x; y; target: { relPath; isDir } | null } | null`（null=空白处）
- `dropTarget: string | null`（拖拽悬停高亮目录）

### `XtermTerminal.ts` 扩展
`bindDragAndDrop` 的 `PI_FILE_DRAG_MIME` 解析改为读 JSON 数组 → 多路径空格拼接插入。

### 样式 `src/renderer/styles/app.css`
新增：`.file-row.selected` / `.file-row.cut-pending`（半透明）/ `.file-row.drop-target` / `.file-rename-input` / `.file-empty-node`（C2 伪节点）。

---

## 三、实施步骤（含进度 checkbox）

### 阶段 1：主进程文件操作层
- [x] 1.1 在 `fsBridge.ts` 移除 `resolveSafe` / `FsSecurityError` / `normalize`，并改造现有 4 个函数去掉越权校验。
- [x] 1.2 在 `fsBridge.ts` 新增 `mkdir` / `createFile` / `rename` / `remove` / `copy` / `listNames` / `uniqueName` 七个函数。
- [x] 1.3 在 `main/index.ts` 注册 `fs:mkdir` / `fs:createFile` / `fs:rename` / `fs:remove` / `fs:copy` / `fs:listNames` / `fs:uniqueName` 七个 handler（同步移除 `allowedRoots` helper）。

### 阶段 2：渲染端 IPC 与剪贴板
- [x] 2.1 在 `ipc.ts` 的 `PiApi` 接口补六个方法声明（fsMkdir/fsCreateFile/fsRename/fsRemove/fsCopy/fsListNames/fsUniqueName）。
- [x] 2.2 在 `preload/index.ts` 补对应六个 IPC 桥接。
- [x] 2.3 新建 `lib/clipboard.ts` 应用内内存剪贴板单例（含 subscribe）。

### 阶段 3：FileTree 交互重写（核心）
- [x] 3.1 提升 `selection` / `editing` / `menu` / `dropTarget` / `cutRelPaths` / `dirRefresh` 状态到 `FileTree`。
- [x] 3.2 `TreeNode` 增加 Ctrl+点击多选、普通点击打开、选中高亮。
- [x] 3.3 `TreeNode` inline 编辑（新建伪节点 / 重命名，回车提交、Esc 取消、重名加 `(1)` 后缀）。
- [x] 3.4 `TreeNode` / `FileTree` 右键菜单（目录/文件/空白三种菜单项构造，复用 `ContextMenu`）。
- [x] 3.5 拖拽改造：`onDragStart` 携带 `string[]`（多选集），目录 `onDrop` 移动整集；悬停高亮（`.drop-target`）。
- [x] 3.6 删除流程：单文件直接删；目录/多选弹 `ConfirmDialog` 后批量删。
- [x] 3.7 复制/剪切/粘贴：写 `clipboard`，粘贴相对目标目录落盘；剪切源置灰（`.cut-pending`）。
- [x] 3.8 局部刷新：`bumpDir(relPath)` 精确刷新受影响目录层，不整树重拉。

### 阶段 4：终端多路径拖拽
- [x] 4.1 `XtermTerminal.bindDragAndDrop` 解析 `PI_FILE_DRAG_MIME` 的 JSON 数组，多路径 shell-safe 转义后空格拼接插入。

### 阶段 5：样式与测试
- [x] 5.1 在 `styles/app.css` 补选中/置灰/拖拽悬停/编辑输入样式。
- [x] 5.2 运行 `FilePanel.test.tsx` / `XtermTerminal.test.ts` / `ContextMenu.test.tsx` 等受影响测试，全部通过（59/59）。
- [x] 5.3 `fsBridge.test.ts` 重写为覆盖新文件操作函数（原安全模型测试已废弃），18/18 通过。
- [x] 5.4 全量类型检查（`tsc --noEmit`）通过；`pnpm build` 构建通过。
- [x] 5.5 全量测试：262 个中 259 通过；3 个失败位于 `App.terminal.test.tsx`（集成终端抽屉 T6），经 `git stash` 验证为**预先存在、与本次改动无关**的 Electron 无头环境不稳定问题（`[tray] failed` / `AttachConsole failed`），不在本次范围内。

---

## 四、风险与备注
- `FileTree.tsx` 现有 `FilePanel.test.tsx` 可能需随重写调整。
- `XtermTerminal.test.ts` 含拖拽相关断言，多路径改动后需核对。
- 本次为组件较大重写，按阶段分提交，每阶段可独立验证。
- 安全模型已按用户决策整体移除（含半残状态清理）。
