// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '../components/ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders title/message and cancel/confirm invoke callbacks', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="删除会话" message="确认删除该会话？此操作不可恢复。" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.getByText('删除会话')).toBeInTheDocument();
    expect(screen.getByText('确认删除该会话？此操作不可恢复。')).toBeInTheDocument();
    fireEvent.click(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(screen.getByText('删除'));
    expect(onConfirm).toHaveBeenCalled();
  });
});
