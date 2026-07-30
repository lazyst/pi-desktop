// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SplitDivider } from '../components/SplitDivider';

// Mock child components
vi.mock('../components/SessionPane', () => ({ SessionPane: () => null }));
vi.mock('../components/IntegratedPane', () => ({ IntegratedPane: () => null }));
vi.mock('../components/PreviewTab', () => ({ PreviewTab: () => null }));
vi.mock('../components/DiffTab', () => ({ DiffTab: () => null }));
vi.mock('../components/SessionContentView', () => ({ SessionContentView: () => null }));
vi.mock('../components/paneManager', () => ({ restorePaneScrollState: vi.fn() }));

// Mock useSplitStore
vi.mock('../store/splitStore', async () => {
  const actual = await vi.importActual('../store/splitStore');
  return {
    ...actual,
    useSplitStore: (selector?: any) => {
      const state = {
        cwdTrees: {},
        activeCwd: null,
        activeLeafId: null,
        cwdOrder: [],
        cwdActiveLeafId: {},
        cwdActiveTab: {},
        cwdTabHistory: {},
        terminals: [],
        selectTab: vi.fn(),
        reorderTabsInLeaf: vi.fn(),
        setActiveLeaf: vi.fn(),
        closeCenterTab: vi.fn(),
        setRatios: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
  };
});

describe('SplitDivider', () => {
  it('renders horizontal divider', () => {
    const { container } = render(
      <SplitDivider direction="horizontal" onMouseDown={() => {}} />
    );
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('split-divider--horizontal');
  });

  it('renders vertical divider', () => {
    const { container } = render(
      <SplitDivider direction="vertical" onMouseDown={() => {}} />
    );
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('split-divider--vertical');
  });

  it('calls onMouseDown when clicked', () => {
    const onMouseDown = vi.fn();
    const { container } = render(
      <SplitDivider direction="horizontal" onMouseDown={onMouseDown} />
    );
    container.firstChild?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onMouseDown).toHaveBeenCalled();
  });
});