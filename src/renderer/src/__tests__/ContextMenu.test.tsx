// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from '../components/ContextMenu';

describe('ContextMenu', () => {
  it('renders items and clicking an item invokes onClick', () => {
    const onDelete = vi.fn();
    render(
      <ContextMenu
        x={10}
        y={10}
        items={[{ label: '删除会话', danger: true, onClick: onDelete }]}
        onClose={vi.fn()}
      />,
    );
    const item = screen.getByText('删除会话');
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(onDelete).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu x={10} y={10} items={[{ label: '删除会话', onClick: vi.fn() }]} onClose={onClose} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when mousedown happens outside the menu (e.g. the terminal area)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <div>
        <div data-testid="outside">terminal</div>
        <ContextMenu x={10} y={10} items={[{ label: '删除会话', onClick: vi.fn() }]} onClose={onClose} />
      </div>,
    );
    const outside = container.querySelector('[data-testid="outside"]')!;
    fireEvent.mouseDown(outside);
    expect(onClose).toHaveBeenCalled();
  });
});
