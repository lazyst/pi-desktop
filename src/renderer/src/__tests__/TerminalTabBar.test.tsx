// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TerminalTabBar } from '../components/TerminalTabBar';
import type { IntegratedTerminalInfo } from '../types';

// TerminalTabBar 是通用展示组件（被 TerminalDrawer 复用），自身不耦合 store——
// 它只接收「从 store 取数」后由父层（TerminalDrawer）映射好的 TabItem[] 与 activeId。
// 本文件的契约即 TerminalDrawer 将数据喂给 TerminalTabBar 的精确形状：
//   tabs = terminals.map(t => ({ id: t.id, title: t.title }))  // 源自 store.terminals
//   activeId = store.activeTermId
// 只要该契约稳定，后续阶段在已稳定的壳上改动就不会悄悄破坏交互。
describe('TerminalTabBar', () => {
  const tabs = [
    { id: 'term-1', title: 'PowerShell' },
    { id: 'term-2', title: 'bash' },
  ];

  it('renders all tabs with titles', () => {
    const { container } = render(
      <TerminalTabBar tabs={tabs} activeId="term-1" onSelect={vi.fn()} onClose={vi.fn()} onNew={vi.fn()} />,
    );
    const tabEls = container.querySelectorAll('.terminal-tab');
    expect(tabEls.length).toBe(2);
    expect(tabEls[0].textContent).toContain('PowerShell');
    expect(tabEls[1].textContent).toContain('bash');
    // 当前 active 的 tab 加 active class
    expect(tabEls[0].className).toContain('active');
    expect(tabEls[1].className).not.toContain('active');
  });

  it('clicking a tab triggers onSelect with its id', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TerminalTabBar tabs={tabs} activeId="term-1" onSelect={onSelect} onClose={vi.fn()} onNew={vi.fn()} />,
    );
    const tabEls = container.querySelectorAll('.terminal-tab');
    fireEvent.click(tabEls[1]);
    expect(onSelect).toHaveBeenCalledWith('term-2');
  });

  it('clicking the × triggers onClose with its id (and not onSelect)', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <TerminalTabBar tabs={tabs} activeId="term-1" onSelect={onSelect} onClose={onClose} onNew={vi.fn()} />,
    );
    const closeButtons = container.querySelectorAll('.tab-close');
    fireEvent.click(closeButtons[0]);
    expect(onClose).toHaveBeenCalledWith('term-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking + triggers onNew', () => {
    const onNew = vi.fn();
    const { container } = render(
      <TerminalTabBar tabs={tabs} activeId="term-1" onSelect={vi.fn()} onClose={vi.fn()} onNew={onNew} />,
    );
    const newBtn = container.querySelector('.tab-new') as HTMLElement;
    expect(newBtn).toBeTruthy();
    fireEvent.click(newBtn);
    expect(onNew).toHaveBeenCalledOnce();
  });

  // —— store 取数契约回归：TerminalDrawer 把 store.terminals / activeTermId 映射成
  // TerminalTabBar 的 props 时，形状必须精确（id/title 取自终端实例，active 取自 activeTermId）。
  it('accepts store-derived tab items shaped exactly as TerminalDrawer maps them', () => {
    // 模拟 store.terminals（IntegratedTerminalInfo[]）与 activeTermId。
    const terminals: IntegratedTerminalInfo[] = [
      { id: 'term-1', profileId: 'pwsh', cwd: '/a', title: 'PowerShell' },
      { id: 'term-2', profileId: 'bash', cwd: '/b', title: 'bash' },
    ];
    const activeTermId = 'term-2';
    // TerminalDrawer 的实际映射（见 TerminalDrawer.tsx）。
    const mapped = terminals.map((t) => ({ id: t.id, title: t.title }));
    const onSelect = vi.fn();
    const { container } = render(
      <TerminalTabBar tabs={mapped} activeId={activeTermId} onSelect={onSelect} onClose={vi.fn()} onNew={vi.fn()} />,
    );
    const tabEls = container.querySelectorAll('.terminal-tab');
    expect(tabEls.length).toBe(2);
    // active 应跟随 activeTermId（term-2），而非第一个。
    expect(tabEls[0].className).not.toContain('active');
    expect(tabEls[1].className).toContain('active');
    fireEvent.click(tabEls[0]);
    expect(onSelect).toHaveBeenCalledWith('term-1');
  });
});
