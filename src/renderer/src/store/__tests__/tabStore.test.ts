import { describe, it, expect, beforeEach } from 'vitest';
import { useTabStore, type Tab, type TabLocation } from '../tabStore';

/** 重置 store 到初始空状态，保证用例间隔离。 */
function resetStore() {
  useTabStore.setState({
    tabs: [],
    activeEditorTabId: null,
    activePanelTabId: null,
    terminals: [],
    drawerOpen: false,
    drawerHeight: 240,
    activeTermId: null,
  });
}

/** 取当前 store 状态快照。 */
function getState() {
  return useTabStore.getState();
}

/** 便捷读取某 location 下可见 tab（按 order 排序）。 */
function visibleIn(location: TabLocation): Tab[] {
  return getState()
    .tabs.filter((t) => t.location === location && !t.hidden)
    .sort((a, b) => a.order - b.order);
}

describe('tabStore — 状态容器与 action', () => {
  beforeEach(resetStore);

  describe('openSession', () => {
    it('创建新 session tab 并激活到 editor 指针', () => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      const tab = s.tabs[0];
      expect(tab.kind).toBe('session');
      expect(tab.id).toBe('/a/session.jsonl');
      expect((tab as any).key).toBe('/a/session.jsonl');
      expect(tab.location).toBe('editor');
      expect(tab.hidden).toBe(false);
      expect(tab.order).toBe(0);
      expect(s.activeEditorTabId).toBe('/a/session.jsonl');
      expect(s.activePanelTabId).toBeNull();
    });

    it('同 key 已存在则取消隐藏并激活（不重复创建）', () => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
      getState().hideTab('/a/session.jsonl');
      expect(getState().tabs).toHaveLength(1);
      getState().openSession({ key: '/a/session.jsonl' });
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].hidden).toBe(false);
      expect(s.activeEditorTabId).toBe('/a/session.jsonl');
    });

    it('key 缺失时用 cwd 作为 id 与 key', () => {
      getState().openSession({ cwd: '/b', name: 'sess-b' });
      const s = getState();
      expect(s.tabs[0].id).toBe('/b');
      expect((s.tabs[0] as any).key).toBe('/b');
    });

    it('多个 session 按创建顺序分配 order', () => {
      getState().openSession({ key: 'k1' });
      getState().openSession({ key: 'k2' });
      getState().openSession({ key: 'k3' });
      const orders = visibleIn('editor').map((t) => t.order);
      expect(orders).toEqual([0, 1, 2]);
    });
  });

  describe('openPreview', () => {
    it('用 preview:<root>//<path> 作 id 创建并激活', () => {
      getState().openPreview('/repo', 'src/index.ts');
      const s = getState();
      const tab = s.tabs[0];
      expect(tab.kind).toBe('preview');
      expect(tab.id).toBe('preview:/repo//src/index.ts');
      expect(tab.location).toBe('editor');
      expect(tab.title).toBe('index.ts');
      expect(s.activeEditorTabId).toBe('preview:/repo//src/index.ts');
    });

    it('同 root+path 已存在则激活不重复创建', () => {
      getState().openPreview('/repo', 'a.ts');
      getState().hideTab('preview:/repo//a.ts');
      getState().openPreview('/repo', 'a.ts');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].hidden).toBe(false);
    });
  });

  describe('openDiff', () => {
    it('工作区 diff（commitHash=null）使用 work 后缀 id', () => {
      getState().openDiff('/repo', null);
      const s = getState();
      expect(s.tabs[0].id).toBe('diff:/repo//work');
      expect((s.tabs[0] as any).commitHash).toBeNull();
      expect(s.tabs[0].title).toBe('工作区改动');
    });

    it('指定 commitHash 时使用短 hash 标题', () => {
      getState().openDiff('/repo', 'abc1234def');
      const s = getState();
      expect(s.tabs[0].id).toBe('diff:/repo//abc1234def');
      expect(s.tabs[0].title).toBe('abc1234d');
    });

    it('同 id 已存在则激活不重复创建', () => {
      getState().openDiff('/repo', 'h1');
      getState().hideTab('diff:/repo//h1');
      getState().openDiff('/repo', 'h1');
      expect(getState().tabs).toHaveLength(1);
      expect(getState().tabs[0].hidden).toBe(false);
    });
  });

  describe('openTerminal', () => {
    it('创建 integrated-terminal tab 到 panel 并激活 panel 指针', () => {
      getState().openTerminal('/proj');
      const s = getState();
      const tab = s.tabs[0];
      expect(tab.kind).toBe('integrated-terminal');
      expect(tab.location).toBe('panel');
      expect(tab.id).toBe('terminal:/proj');
      expect(s.activePanelTabId).toBe('terminal:/proj');
      expect(s.activeEditorTabId).toBeNull();
    });

    it('同 cwd 已存在则激活不重复创建', () => {
      getState().openTerminal('/proj');
      getState().openTerminal('/proj');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.activePanelTabId).toBe('terminal:/proj');
    });

    it('editor 与 panel 激活指针互不干扰', () => {
      getState().openSession({ key: 's1' });
      getState().openTerminal('/proj');
      const s = getState();
      expect(s.activeEditorTabId).toBe('s1');
      expect(s.activePanelTabId).toBe('terminal:/proj');
    });
  });

  describe('selectTab', () => {
    it('editor tab 写入 activeEditorTabId', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().selectTab('s1');
      expect(getState().activeEditorTabId).toBe('s1');
    });

    it('panel tab 写入 activePanelTabId', () => {
      getState().openTerminal('/p1');
      getState().openTerminal('/p2');
      getState().selectTab('terminal:/p2');
      expect(getState().activePanelTabId).toBe('terminal:/p2');
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1' });
      getState().selectTab('nope');
      expect(getState().activeEditorTabId).toBe('s1');
    });
  });

  describe('closeTab', () => {
    it('移除 tab；若为 editor 激活项则回退到下一个可见 editor tab', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().closeTab('s1');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].id).toBe('s2');
      expect(s.activeEditorTabId).toBe('s2');
    });

    it('移除 tab；若为 panel 激活项则回退到下一个可见 panel tab', () => {
      getState().openTerminal('/p1');
      getState().openTerminal('/p2');
      getState().closeTab('terminal:/p1');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.activePanelTabId).toBe('terminal:/p2');
    });

    it('关闭隐藏（keep-alive）的 session 仍真移除（closeTab=卸载语义）', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      getState().closeTab('s1');
      expect(getState().tabs).toHaveLength(0);
      expect(getState().activeEditorTabId).toBeNull();
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1' });
      getState().closeTab('nope');
      expect(getState().tabs).toHaveLength(1);
    });
  });

  describe('hideTab', () => {
    it('置 hidden=true 且不卸载（tab 仍在 tabs 中）', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().hideTab('s1');
      const s = getState();
      expect(s.tabs).toHaveLength(2);
      expect(s.tabs.find((t) => t.id === 's1')!.hidden).toBe(true);
    });

    it('隐藏激活的 editor tab 时，激活态切到下一个可见 editor tab', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().hideTab('s1');
      expect(getState().activeEditorTabId).toBe('s2');
    });

    it('隐藏最后一个可见 editor tab 后激活指针为 null', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      expect(getState().activeEditorTabId).toBeNull();
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('nope');
      expect(getState().tabs[0].hidden).toBe(false);
    });
  });

  describe('setHidden', () => {
    it('setHidden(id, true) 等价于 hideTab', () => {
      getState().openSession({ key: 's1' });
      getState().setHidden('s1', true);
      expect(getState().tabs[0].hidden).toBe(true);
    });

    it('setHidden(id, false) 取消隐藏；若所在 location 无激活项则激活它', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      getState().setHidden('s1', false);
      const s = getState();
      expect(s.tabs[0].hidden).toBe(false);
      expect(s.activeEditorTabId).toBe('s1');
    });

    it('setHidden 与当前状态相同则为 no-op', () => {
      getState().openSession({ key: 's1' });
      const before = getState().tabs;
      getState().setHidden('s1', false);
      expect(getState().tabs).toBe(before);
    });
  });

  describe('closeCenterTab', () => {
    it('session 终端：关闭 = 仅隐藏 keep-alive（hidden:true 且不卸载），激活指针留在被隐藏 tab 上', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: 's2', cwd: '/b', name: 'sess-b' });
      getState().selectTab('s1');
      // 关闭 s1 → 实例仍在 tabs 中，仅置 hidden，内容实例不卸载（切回恢复滚动/历史）。
      getState().closeCenterTab('s1');
      const s = getState();
      expect(s.tabs).toHaveLength(2);
      const s1 = s.tabs.find((t) => t.id === 's1')!;
      expect(s1.hidden).toBe(true);
      // keep-alive：隐藏不卸载，激活指针留在被隐藏的 tab（CenterPane 仍渲染其内容为 active，
      // 仅 TabBar 过滤掉 hidden；从侧边栏重开即恢复滚动/历史）。这正是「关闭=隐藏」语义。
      expect(s.activeEditorTabId).toBe('s1');
    });

    it('session 已隐藏再 closeCenterTab 为 no-op（不会重复翻转或误卸载）', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().closeCenterTab('s1');
      const before = getState().tabs;
      getState().closeCenterTab('s1');
      const s = getState();
      expect(s.tabs).toBe(before);
      expect(s.tabs[0].hidden).toBe(true);
    });

    it('preview / diff 关闭 = 真移除（无 keep-alive）', () => {
      getState().openPreview('/repo', 'a.ts');
      getState().openDiff('/repo', null);
      getState().closeCenterTab('preview:/repo//a.ts');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].id).toBe('diff:/repo//work');
    });

    it('关闭激活的 preview tab 后激活指针回退到下一个可见 editor tab（preview 为真移除）', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openPreview('/repo', 'a.ts');
      getState().openPreview('/repo', 'b.ts');
      getState().selectTab('preview:/repo//a.ts');
      getState().closeCenterTab('preview:/repo//a.ts');
      const s = getState();
      // a.ts 被真移除；b.ts 预览仍保留（仅移除被关的那一个）。
      expect(s.tabs.find((t) => t.id === 'preview:/repo//a.ts')).toBeUndefined();
      expect(s.tabs.find((t) => t.id === 'preview:/repo//b.ts')).toBeTruthy();
      // 激活指针回退到下一个可见 editor tab（按 order 首个为 session s1）。
      expect(s.activeEditorTabId).toBe('s1');
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().closeCenterTab('nope');
      expect(getState().tabs).toHaveLength(1);
    });
  });

  describe('removeTerminal', () => {
    it('移除对应终端 tab，若为激活态则激活态迁移到剩余第一个', () => {
      const list = [
        { id: 't-1', profileId: 'p', cwd: '/a', title: 'a' },
        { id: 't-2', profileId: 'p', cwd: '/b', title: 'b' },
        { id: 't-3', profileId: 'p', cwd: '/c', title: 'c' },
      ];
      useTabStore.setState({ terminals: list, activeTermId: 't-2' });
      getState().removeTerminal('t-2');
      const s = getState();
      expect(s.terminals.map((t) => t.id)).toEqual(['t-1', 't-3']);
      // 激活态迁移到剩余第一个（t-1）。
      expect(s.activeTermId).toBe('t-1');
    });

    it('移除最后一个终端后激活态置 null', () => {
      useTabStore.setState({
        terminals: [{ id: 't-1', profileId: 'p', cwd: '/a', title: 'a' }],
        activeTermId: 't-1',
      });
      getState().removeTerminal('t-1');
      const s = getState();
      expect(s.terminals).toHaveLength(0);
      expect(s.activeTermId).toBeNull();
    });

    it('移除非激活终端不影响当前激活指针', () => {
      const list = [
        { id: 't-1', profileId: 'p', cwd: '/a', title: 'a' },
        { id: 't-2', profileId: 'p', cwd: '/b', title: 'b' },
      ];
      useTabStore.setState({ terminals: list, activeTermId: 't-1' });
      getState().removeTerminal('t-2');
      expect(getState().activeTermId).toBe('t-1');
    });
  });

  describe('drawer 状态（开关 / 高度持久化语义）', () => {
    it('toggleDrawer 在开/关间翻转', () => {
      expect(getState().drawerOpen).toBe(false);
      getState().toggleDrawer();
      expect(getState().drawerOpen).toBe(true);
      getState().toggleDrawer();
      expect(getState().drawerOpen).toBe(false);
    });

    it('setDrawerOpen 直接设置展开态', () => {
      getState().setDrawerOpen(true);
      expect(getState().drawerOpen).toBe(true);
      getState().setDrawerOpen(false);
      expect(getState().drawerOpen).toBe(false);
    });

    it('setDrawerHeight 写入高度（持久化由 App 负责，store 仅管状态）', () => {
      getState().setDrawerHeight(360);
      expect(getState().drawerHeight).toBe(360);
    });

    it('setActiveTermId 写入当前激活集成终端指针', () => {
      getState().setActiveTermId('t-9');
      expect(getState().activeTermId).toBe('t-9');
      getState().setActiveTermId(null);
      expect(getState().activeTermId).toBeNull();
    });

    it('setTerminals 用主进程推送的完整列表覆盖（单一事实来源）', () => {
      const list = [
        { id: 't-1', profileId: 'p', cwd: '/a', title: 'a' },
        { id: 't-2', profileId: 'p', cwd: '/b', title: 'b' },
      ];
      getState().setTerminals(list);
      expect(getState().terminals).toHaveLength(2);
      // 再次推送（如 create 后广播）应整体覆盖，不产生重复 id。
      getState().setTerminals([{ id: 't-1', profileId: 'p', cwd: '/a', title: 'a' }]);
      const s = getState();
      expect(s.terminals).toHaveLength(1);
      expect(s.terminals[0].id).toBe('t-1');
    });
  });

  describe('reorderTabs', () => {
    it('按传入顺序重排同 location 的 order', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().openSession({ key: 's3' });
      getState().reorderTabs('editor', ['s3', 's1', 's2']);
      const byId = Object.fromEntries(visibleIn('editor').map((t) => [t.id, t.order]));
      expect(byId['s3']).toBe(0);
      expect(byId['s1']).toBe(1);
      expect(byId['s2']).toBe(2);
    });

    it('不影响其他 location 的 tab', () => {
      getState().openSession({ key: 's1' });
      getState().openTerminal('/p1');
      getState().openTerminal('/p2');
      getState().reorderTabs('editor', ['s1']);
      // panel 不受影响
      const panelOrders = visibleIn('panel').map((t) => t.order);
      expect(panelOrders).toEqual([0, 1]);
      expect(getState().tabs.find((t) => t.id === 's1')!.order).toBe(0);
    });

    it('传入顺序外的同 location tab 保持原 order', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().openSession({ key: 's3' });
      // 只重排 s1、s3，s2 保持 order=1
      getState().reorderTabs('editor', ['s3', 's1']);
      const s2 = getState().tabs.find((t) => t.id === 's2')!;
      expect(s2.order).toBe(1);
      expect(getState().tabs.find((t) => t.id === 's3')!.order).toBe(0);
      expect(getState().tabs.find((t) => t.id === 's1')!.order).toBe(1);
    });
  });
});
