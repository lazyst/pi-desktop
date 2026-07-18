// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import { clampSidebarWidth } from '../components/sidebarGeometry';

const sessions = [{ key: 'k1', cwd: 'C:\\Users\\hcz\\.pi-agent', name: 'e2e-session' }];

function renderWithResize(overrides: any = {}) {
  const onSidebarResize = vi.fn();
  const onTerminate = overrides.onTerminate ?? vi.fn();
  (window as any).pi = {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
  };
  const utils = render(
    <Sidebar
      sessions={overrides.sessions ?? sessions}
      statusMap={overrides.statusMap ?? {}}
      pinned={[]}
      sidebarWidth={overrides.sidebarWidth ?? 280}
      onSidebarResize={overrides.onSidebarResize ?? onSidebarResize}
      onOpen={vi.fn()}
      onTerminate={onTerminate}
      onPickDirectory={vi.fn()}
      onTogglePin={vi.fn()}
      onDeleteSession={vi.fn()}
      selectedKeys={new Set<string>()}
      onToggleSelect={vi.fn()}
      onClearDirectory={vi.fn()}
      onEnterSelect={vi.fn()}
      onExitSelect={vi.fn()}
      onBatchDelete={vi.fn()}
      onRemoveDir={vi.fn()}
    />,
  );
  return { onSidebarResize, onTerminate, ...utils };
}

describe('Sidebar terminate button visibility', () => {
  it('shows 终止进程 when status is running', () => {
    const { container } = renderWithResize({ statusMap: { 'k1': 'running' } });
    expect(container.querySelector('.terminate')).toBeTruthy();
  });

  it('shows 终止进程 when status is unknown (undefined) as a UX fallback', () => {
    // 状态推送尚未到达/竞态时，会话仍在运行，隐藏按钮会使用户“无法终止”。
    const { container } = renderWithResize({ statusMap: {} });
    expect(container.querySelector('.terminate')).toBeTruthy();
  });

  it('hides 终止进程 when status is dead', () => {
    const { container } = renderWithResize({ statusMap: { 'k1': 'dead' } });
    expect(container.querySelector('.terminate')).toBeNull();
  });

  it('calls onTerminate with the disk key when clicked', () => {
    const { container, onTerminate } = renderWithResize({ statusMap: { 'k1': 'running' } });
    fireEvent.click(container.querySelector('.terminate')!);
    expect(onTerminate).toHaveBeenCalledWith('k1');
  });
});

describe('Sidebar resizer (draggable width)', () => {
  it('applies the persisted sidebarWidth as inline width on mount', () => {
    const { container } = renderWithResize({ sidebarWidth: 320 });
    const aside = container.querySelector('.sidebar') as HTMLElement;
    expect(aside.style.width).toBe('320px');
  });

  it('exposes a resizer element on the right border', () => {
    const { container } = renderWithResize();
    expect(container.querySelector('.sidebar-resizer')).toBeTruthy();
  });

  it('drags to resize, persists the clamped width on mouseup', () => {
    const { container, onSidebarResize } = renderWithResize({ sidebarWidth: 280 });
    const rz = container.querySelector('.sidebar-resizer')!;
    const expected = clampSidebarWidth(280 + 300, window.innerWidth); // dx = 300

    fireEvent.mouseDown(rz, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 300 });

    const aside = container.querySelector('.sidebar') as HTMLElement;
    expect(aside.style.width).toBe(`${expected}px`);

    fireEvent.mouseUp(document);
    expect(onSidebarResize).toHaveBeenCalledWith(expected);
  });

  it('clamps to the 200px floor when dragged far left', () => {
    const { container, onSidebarResize } = renderWithResize({ sidebarWidth: 280 });
    const rz = container.querySelector('.sidebar-resizer')!;
    const expected = clampSidebarWidth(280 - 500, window.innerWidth);

    fireEvent.mouseDown(rz, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: -500 });
    fireEvent.mouseUp(document);

    expect(onSidebarResize).toHaveBeenCalledWith(expected);
  });

  it('clamps to the 60%-of-window ceiling when dragged far right', () => {
    const { container, onSidebarResize } = renderWithResize({ sidebarWidth: 280 });
    const rz = container.querySelector('.sidebar-resizer')!;
    const expected = clampSidebarWidth(280 + 1000, window.innerWidth);

    fireEvent.mouseDown(rz, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 1000 });
    fireEvent.mouseUp(document);

    expect(onSidebarResize).toHaveBeenCalledWith(expected);
  });
});
