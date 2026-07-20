// TabAutoGroup（ADR-0001 E3）共享分组工具：按 groupBy 返回的键对 tabs 做
// 「稳定聚簇排序」——同键 tab 聚成一段（段内保持父层传入的原有相对顺序），
// 不同键之间插入分隔符占位（非 tab，仅视觉分段）。无 groupBy 或不分组时原样返回。
//
// 注意：本函数只重排「展示顺序」，不改 tabs 数据；拖拽的 handleDragEnd 仍基于
// 原始 tabs 数组计算下标，故分组与 TabReorder（T11 拖拽重排）互不干扰。
// 抽成共享工具，避免 TabBar / TerminalTabBar 各抄一份（重复代码 smell）。

export type RenderedRow<T> = { type: 'tab'; item: T } | { type: 'sep' };

export function buildGroupedRows<T>(
  tabs: T[],
  groupBy?: (t: T) => string | undefined,
): RenderedRow<T>[] {
  if (!groupBy) return tabs.map((item) => ({ type: 'tab', item }));

  // 稳定聚簇：按「首次出现顺序」给每个键排定段序，再按段序稳定排序，
  // 段内保持原相对顺序；最后在相邻不同段之间插分隔符。
  const segmentOrder = new Map<string, number>();
  let nextSeg = 0;
  for (const item of tabs) {
    const key = groupBy(item) ?? '';
    if (!segmentOrder.has(key)) segmentOrder.set(key, nextSeg++);
  }
  const ordered = [...tabs].sort(
    (a, b) => (segmentOrder.get(groupBy(a) ?? '')! - segmentOrder.get(groupBy(b) ?? '')!),
  );

  const rows: RenderedRow<T>[] = [];
  let lastKey: string | undefined = undefined;
  for (const item of ordered) {
    const key = groupBy(item) ?? '';
    if (lastKey !== undefined && key !== lastKey) rows.push({ type: 'sep' });
    rows.push({ type: 'tab', item });
    lastKey = key;
  }
  return rows;
}
