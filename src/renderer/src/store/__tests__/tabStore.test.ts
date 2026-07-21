import { describe, it, expect, beforeEach } from 'vitest';
import { useTabStore, type Tab, type TabLocation } from '../tabStore';

/** 重置 store 到初始空状态，保证用例间隔离。 */
function resetStore() {
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    terminals: [],
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
    it('创建新 session tab 并激活', () => {
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
      expect(s.activeTabId).toBe('/a/session.jsonl');
    });

    it('同 key 已存在则取消隐藏并激活（不重复创建）', () => {
      getState().openSession({ key: '/a/session.jsonl', cwd: '/a', name: 'sess-a' });
      getState().hideTab('/a/session.jsonl');
      expect(getState().tabs).toHaveLength(1);
      getState().openSession({ key: '/a/session.jsonl' });
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].hidden).toBe(false);
      expect(s.activeTabId).toBe('/a/session.jsonl');
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
      expect(s.activeTabId).toBe('preview:/repo//src/index.ts');
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
    it('创建 integrated-terminal tab 并激活指针', () => {
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      const s = getState();
      const tab = s.tabs[0];
      expect(tab.kind).toBe('integrated-terminal');
      expect(tab.location).toBe('editor');
      expect(tab.id).toBe('terminal:/proj');
      expect(s.activeTabId).toBe('terminal:/proj');
    });

    it('同 id 已存在则激活不重复创建', () => {
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      getState().openTerminal('terminal:/proj', '/proj', 'Terminal');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.activeTabId).toBe('terminal:/proj');
    });
  });

  describe('selectTab', () => {
    it('写入 activeTabId', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().selectTab('s1');
      expect(getState().activeTabId).toBe('s1');
    });

    it('写入 activeTabId（terminal tab）', () => {
      getState().openTerminal('terminal:/p1', '/p1', 'Terminal');
      getState().openTerminal('terminal:/p2', '/p2', 'Terminal');
      getState().selectTab('terminal:/p2');
      expect(getState().activeTabId).toBe('terminal:/p2');
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1' });
      getState().selectTab('nope');
      expect(getState().activeTabId).toBe('s1');
    });
  });

  describe('closeTab', () => {
    it('移除 tab；若为激活项则回退到下一个可见 tab', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().closeTab('s1');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].id).toBe('s2');
      expect(s.activeTabId).toBe('s2');
    });

    it('移除 terminal tab 后回退到下一个可见 tab', () => {
      getState().openTerminal('terminal:/p1', '/p1', 'Terminal');
      getState().openTerminal('terminal:/p2', '/p2', 'Terminal');
      getState().closeTab('terminal:/p1');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.activeTabId).toBe('terminal:/p2');
    });

    it('关闭隐藏（keep-alive）的 session 仍真移除（closeTab=卸载语义）', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      getState().closeTab('s1');
      expect(getState().tabs).toHaveLength(0);
      expect(getState().activeTabId).toBeNull();
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

    it('隐藏激活的 tab 时，激活态切到下一个可见 tab', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().hideTab('s1');
      expect(getState().activeTabId).toBe('s2');
    });

    it('隐藏最后一个可见 tab 后激活指针为 null', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      expect(getState().activeTabId).toBeNull();
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

    it('setHidden(id, false) 取消隐藏；若无激活项则激活它', () => {
      getState().openSession({ key: 's1' });
      getState().hideTab('s1');
      getState().setHidden('s1', false);
      const s = getState();
      expect(s.tabs[0].hidden).toBe(false);
      expect(s.activeTabId).toBe('s1');
    });

    it('setHidden 与当前状态相同则为 no-op', () => {
      getState().openSession({ key: 's1' });
      const before = getState().tabs;
      getState().setHidden('s1', false);
      expect(getState().tabs).toBe(before);
    });
  });

  describe('closeCenterTab', () => {
    it('session 终端：关闭 = 仅隐藏 keep-alive（hidden:true 且不卸载），激活指针移到下一个可见 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openSession({ key: 's2', cwd: '/b', name: 'sess-b' });
      getState().selectTab('s1');
      // 关闭 s1 → 实例仍在 tabs 中，仅置 hidden，内容实例不卸载（切回恢复滚动/历史）。
      getState().closeCenterTab('s1');
      const s = getState();
      expect(s.tabs).toHaveLength(2);
      const s1 = s.tabs.find((t) => t.id === 's1')!;
      expect(s1.hidden).toBe(true);
      // keep-alive：隐藏不卸载；但激活指针应移到下一个可见 tab，避免 TabBar 无选中项。
      // TabBar 只渲染 visibleTabs（!hidden），若 activeTabId 指向 hidden tab 则无 tab 高亮。
      expect(s.activeTabId).toBe('s2');
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

    it('关闭激活的 preview tab 后激活指针回退到下一个可见 tab（preview 为真移除）', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openPreview('/repo', 'a.ts');
      getState().openPreview('/repo', 'b.ts');
      getState().selectTab('preview:/repo//a.ts');
      getState().closeCenterTab('preview:/repo//a.ts');
      const s = getState();
      // a.ts 被真移除；b.ts 预览仍保留（仅移除被关的那一个）。
      expect(s.tabs.find((t) => t.id === 'preview:/repo//a.ts')).toBeUndefined();
      expect(s.tabs.find((t) => t.id === 'preview:/repo//b.ts')).toBeTruthy();
      // 激活指针回退到下一个可见 tab（按 order 首个为 session s1）。
      expect(s.activeTabId).toBe('s1');
    });

    it('不存在的 id 不改变状态', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().closeCenterTab('nope');
      expect(getState().tabs).toHaveLength(1);
    });
  });

  describe('removeTerminalTab', () => {
    it('移除 terminal tab（kind=integrated-terminal），激活态迁移到下一个可见 tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openTerminal('t-1', '/a', 'Terminal');
      getState().openTerminal('t-2', '/b', 'Terminal');
      getState().openTerminal('t-3', '/c', 'Terminal');
      // activeTabId 现在指向最后打开的 t-3
      getState().selectTab('t-2');
      getState().removeTerminalTab('t-2');
      const s = getState();
      expect(s.tabs.find((t) => t.kind === 'integrated-terminal' && t.id === 't-2')).toBeUndefined();
      // 激活态迁移到下一个可见 tab（按 order 首个为 s1）。
      expect(s.activeTabId).toBe('s1');
    });

    it('移除最后一个 terminal tab 后 activeTabId 迁移到 session tab', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openTerminal('t-1', '/a', 'Terminal');
      getState().removeTerminalTab('t-1');
      const s = getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0].kind).toBe('session');
      expect(s.activeTabId).toBe('s1');
    });

    it('移除非激活 terminal tab 不影响当前 activeTabId', () => {
      getState().openSession({ key: 's1', cwd: '/a', name: 'sess-a' });
      getState().openTerminal('t-1', '/a', 'Terminal');
      getState().openTerminal('t-2', '/b', 'Terminal');
      getState().selectTab('t-1');
      getState().removeTerminalTab('t-2');
      expect(getState().activeTabId).toBe('t-1');
    });
  });

  describe('setTerminals（主进程推送覆盖）', () => {
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
    it('按传入顺序重排 order', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().openSession({ key: 's3' });
      getState().reorderTabs(['s3', 's1', 's2']);
      const byId = Object.fromEntries(visibleIn('editor').map((t) => [t.id, t.order]));
      expect(byId['s3']).toBe(0);
      expect(byId['s1']).toBe(1);
      expect(byId['s2']).toBe(2);
    });

    it('不影响不在 orderedIds 中的 tab', () => {
      getState().openSession({ key: 's1' });
      getState().openTerminal('terminal:/p1', '/p1', 'Terminal');
      getState().openTerminal('terminal:/p2', '/p2', 'Terminal');
      getState().reorderTabs(['s1']);
      // 未在 orderedIds 中的 terminal tab 保持原 order
      expect(getState().tabs.find((t) => t.id === 's1')!.order).toBe(0);
      expect(getState().tabs.find((t) => t.id === 'terminal:/p1')!.order).toBe(1);
      expect(getState().tabs.find((t) => t.id === 'terminal:/p2')!.order).toBe(2);
    });

    it('传入顺序外的 tab 保持原 order', () => {
      getState().openSession({ key: 's1' });
      getState().openSession({ key: 's2' });
      getState().openSession({ key: 's3' });
      // 只重排 s1、s3，s2 保持 order=1
      getState().reorderTabs(['s3', 's1']);
      const s2 = getState().tabs.find((t) => t.id === 's2')!;
      expect(s2.order).toBe(1);
      expect(getState().tabs.find((t) => t.id === 's3')!.order).toBe(0);
      expect(getState().tabs.find((t) => t.id === 's1')!.order).toBe(1);
    });
  });
});
