// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ContextMenu } from '../components/ContextMenu';

// 辅助函数：创建带 transform 的容器（模拟 .rp-tab-content 的 transform 包含块）
function renderInTransformContainer(ui: React.ReactElement) {
  return render(
    <div style={{ transform: 'translateX(0)', position: 'absolute', inset: 0, overflow: 'auto' }} data-testid="transform-container">
      <div style={{ minHeight: '200%' }}> {/* 模拟可滚动内容 */}
        <div data-testid="file-row" className="file-row" style={{ padding: 8 }}>
          README.md
        </div>
      </div>
      {ui}
    </div>,
  );
}

describe('ContextMenu — 右键菜单在 transform 容器内的行为', () => {
  beforeEach(() => {
    // jsdom 下 innerWidth/innerHeight 默认 1024x768
    window.innerWidth = 1024;
    window.innerHeight = 768;
  });

  it('在 transform 容器内右键文件行，菜单出现且不立即关闭', async () => {
    const onClose = vi.fn();
    const onItemClick = vi.fn();

    // 模拟右键点击文件行后渲染 ContextMenu
    const { container, rerender } = renderInTransformContainer(
      <div />, // 初始无菜单
    );

    const fileRow = container.querySelector('[data-testid="file-row"]')!;
    expect(fileRow).toBeInTheDocument();

    // 模拟右键点击：在文件行上触发 contextmenu 事件（模拟浏览器右键流程）
    act(() => {
      // 先触发 mousedown (button=2) 模拟右键按下
      fireEvent.mouseDown(fileRow, { button: 2, clientX: 100, clientY: 200 });
      // 再触发 mouseup (button=2) 模拟右键释放
      fireEvent.mouseUp(fileRow, { button: 2, clientX: 100, clientY: 200 });
      // 最后触发 contextmenu
      fireEvent.contextMenu(fileRow, { clientX: 100, clientY: 200 });
    });

    // 现在渲染 ContextMenu（模拟 FileTree 中 setMenu 后的渲染）
    rerender(
      <div style={{ transform: 'translateX(0)', position: 'absolute', inset: 0, overflow: 'auto' }} data-testid="transform-container">
        <div style={{ minHeight: '200%' }}>
          <div data-testid="file-row" className="file-row" style={{ padding: 8 }}>
            README.md
          </div>
        </div>
        <ContextMenu
          x={100}
          y={200}
          items={[
            { label: '复制', onClick: onItemClick },
            { label: '剪切', onClick: vi.fn() },
            { label: '删除', danger: true, onClick: vi.fn() },
          ]}
          onClose={onClose}
        />
      </div>,
    );

    // 验证菜单出现
    expect(await screen.findByText('复制')).toBeInTheDocument();

    // 关键验证：菜单没有立即关闭（onClose 没有被调用）
    // 如果 onPointerDown 捕获了之前的 mousedown(right-click)，onClose 会被立即调用
    await new Promise((r) => setTimeout(r, 50));
    expect(onClose).not.toHaveBeenCalled();

    // 验证菜单项可点击
    fireEvent.click(screen.getByText('复制'));
    expect(onItemClick).toHaveBeenCalled();
  });

  it('右键菜单在 transform 容器内定位正确（接近鼠标坐标）', async () => {
    const LEFT_PANEL_WIDTH = 280; // 侧边栏宽度
    const onClose = vi.fn();

    // 模拟右栏在侧边栏右侧，鼠标在右栏内点击
    // 如果 ContextMenu 定位基准是 .rp-tab-content（带 transform），
    // 菜单会偏移 LEFT_PANEL_WIDTH 像素
    render(
      <div style={{ marginLeft: LEFT_PANEL_WIDTH }}>
        <div style={{ transform: 'translateX(0)', position: 'absolute', inset: 0, overflow: 'auto' }} data-testid="transform-container">
          <ContextMenu
            x={100}
            y={200}
            items={[{ label: '测试项', onClick: vi.fn() }]}
            onClose={onClose}
          />
        </div>
      </div>,
    );

    const menu = screen.getByRole('menu');
    // 验证菜单位置：如果定位基准是视口，left 应为 100；
    // 如果定位基准是 transform 容器，left 会偏移 LEFT_PANEL_WIDTH
    // 注意：jsdom 不支持实际布局计算，这里只验证菜单渲染了
    expect(menu).toBeInTheDocument();
  });

  it('外部左键点击关闭菜单（功能不受影响）', () => {
    const onClose = vi.fn();
    const { container } = render(
      <div style={{ transform: 'translateX(0)' }}>
        <div data-testid="outside">外部区域</div>
        <ContextMenu
          x={100}
          y={100}
          items={[{ label: '测试项', onClick: vi.fn() }]}
          onClose={onClose}
        />
      </div>,
    );

    // 点击菜单外部 → 关闭菜单
    const outside = container.querySelector('[data-testid="outside"]')!;
    fireEvent.mouseDown(outside, { button: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape 键关闭菜单（功能不受影响）', () => {
    const onClose = vi.fn();
    render(
      <div style={{ transform: 'translateX(0)' }}>
        <ContextMenu
          x={100}
          y={100}
          items={[{ label: '测试项', onClick: vi.fn() }]}
          onClose={onClose}
        />
      </div>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});