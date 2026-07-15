// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { WindowResizeZones } from '../components/WindowResizeZones';

function setMax(m: boolean, mockBounds = { x: 0, y: 0, width: 800, height: 600 }) {
  (window as any).pi = {
    onMaximizeChange: (fn: (m: boolean) => void) => {
      fn(m);
    },
    getWindowBounds: vi.fn().mockResolvedValue(mockBounds),
    setWindowBounds: vi.fn(),
  };
}

describe('WindowResizeZones', () => {
  it('renders 7 zones (top-right omitted) when not maximized, yielding the top-right corner', () => {
    setMax(false);
    render(<WindowResizeZones />);

    // 8 - 1 (top-right deleted) = 7
    expect(document.querySelectorAll('.rz').length).toBe(7);
    expect(document.querySelector('.rz-top-right')).toBeNull();
    // the rest remain
    expect(document.querySelector('.rz-top')).toBeTruthy();
    expect(document.querySelector('.rz-right')).toBeTruthy();
    expect(document.querySelector('.rz-left')).toBeTruthy();
    expect(document.querySelector('.rz-bottom')).toBeTruthy();
    expect(document.querySelector('.rz-top-left')).toBeTruthy();
    expect(document.querySelector('.rz-bottom-left')).toBeTruthy();
    expect(document.querySelector('.rz-bottom-right')).toBeTruthy();
  });

  it('hides every resize zone when the window is maximized', () => {
    setMax(true);
    render(<WindowResizeZones />);
    expect(document.querySelectorAll('.rz').length).toBe(0);
  });
});
