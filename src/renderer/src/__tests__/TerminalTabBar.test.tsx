// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TerminalTabBar } from '../components/TerminalTabBar';

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
    const closeBtns = container.querySelectorAll('.tab-close');
    fireEvent.click(closeBtns[0]);
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
});
