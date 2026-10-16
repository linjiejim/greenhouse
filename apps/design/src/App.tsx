import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Columns3, Menu as MenuIcon, Moon, PanelLeftOpen, Smartphone, Sun } from 'lucide-react';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { Button, ConfirmDialog, IconButton, KitProvider, Overlay, Toast } from '@greenhouse/ui/kit';
import { DesignContext, type Confirmation, type Marks } from './context';
import {
  agents,
  capabilities,
  chats,
  initialRecords,
  modules,
  runs,
  saveRecord,
  type Capability,
  type ModuleId,
  type RecordItem,
} from './data';
import { NativeSelect } from './components';
import { Page } from './pages';
import { ChatPage } from './chat';
import { ComponentLab } from './lab';
import { MobileModuleBar, ModuleSidebar, Rail, defaultSelection } from './shell';
import {
  AgentProfile,
  CreatePanel,
  DocumentDetail,
  LoginPage,
  NewAgentForm,
  ProviderDrawer,
  RecordDrawer,
  RunDetail,
} from './details';
import { documents } from './data';

type Panel =
  | { type: 'record'; item: RecordItem; editing: boolean }
  | { type: 'document' | 'run'; id: string }
  | { type: 'agent'; id: string; tab?: string }
  | { type: 'provider'; capability: Capability; personal: boolean }
  | { type: 'create'; module: ModuleId }
  | { type: 'content'; title: string; content: ReactNode };

const initialMarks: Marks = { pinned: chats.pinned.map((title) => `chat:${title}`), muted: [], read: [], hidden: [] };

function route(): ModuleId {
  const hash = location.hash.slice(1).split(/[/?]/)[0];
  return modules.some((item) => item.id === hash) ? (hash as ModuleId) : 'chat';
}

export function App() {
  const [module, setModule] = useState<ModuleId>(route);
  const [selections, setSelections] = useState<Record<ModuleId, string>>(defaultSelection);
  const [scope, setScope] = useState('团队');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light');
  const [viewport, setViewport] = useState('桌面');
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [smallScreen, setSmallScreen] = useState(window.matchMedia('(max-width: 767px)').matches);
  const [density, setDensity] = useState<'舒适' | '紧凑'>('舒适');
  const [records, setRecords] = useState(initialRecords);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; onClick: () => void } } | null>(null);
  const [revision, setRevision] = useState(0);
  const [marks, setMarks] = useState(initialMarks);
  const mark = useCallback(
    (kind: keyof Marks, key: string, on?: boolean) =>
      setMarks((current) => {
        const has = current[kind].includes(key);
        const next = on ?? !has;
        if (next === has) return current;
        return { ...current, [kind]: next ? [...current[kind], key] : current[kind].filter((item) => item !== key) };
      }),
    [],
  );
  const mobile = viewport === '手机' || smallScreen;
  const selection = selections[module];
  useEffect(() => {
    const listener = () => {
      setModule(route());
      setPanel(null);
      setDirty(false);
      setConfirmDiscard(false);
      setDrawer(false);
    };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const narrow = window.matchMedia('(max-width: 767px)');
    const change = () => setSystemDark(media.matches);
    const size = () => setSmallScreen(narrow.matches);
    media.addEventListener('change', change);
    narrow.addEventListener('change', size);
    return () => {
      media.removeEventListener('change', change);
      narrow.removeEventListener('change', size);
    };
  }, []);
  const select = useCallback(
    (value: string) => {
      setSelections((current) => ({ ...current, [module]: value }));
      setDrawer(false);
    },
    [module],
  );
  const navigate = (next: ModuleId, nextSelection?: string) => {
    if (nextSelection !== undefined) setSelections((current) => ({ ...current, [next]: nextSelection }));
    if (next !== module) location.hash = next;
    setDrawer(false);
  };
  const notify = useCallback(
    (text: string, action?: { label: string; onClick: () => void }) => setNotice({ text, action }),
    [],
  );
  const reset = () => {
    setRecords(initialRecords);
    setSelections(defaultSelection);
    setScope('团队');
    setPanel(null);
    setDirty(false);
    setConfirmDiscard(false);
    setNotice(null);
    setConfirmation(null);
    setRevision((value) => value + 1);
    setCollapsed(false);
    setMarks(initialMarks);
  };
  const open = (value: Panel) => {
    setDirty(false);
    setConfirmDiscard(false);
    setPanel(value);
    setDrawer(false);
  };
  /** Unsaved edits ask first (patterns.md, 列表与详情); answers false to keep the panel open. */
  const mayClose = () => {
    if (!dirty) return true;
    setConfirmDiscard(true);
    return false;
  };
  const close = () => {
    if (mayClose()) setPanel(null);
  };
  const newRecord = (): RecordItem => ({
    ...initialRecords[0],
    id: `GH-${Math.max(...records.map((item) => Number(item.id.slice(3)))) + 1}`,
    title: '',
    status: '待处理',
    note: '',
  });
  const newItem = () => {
    if (module === 'tables') open({ type: 'record', item: newRecord(), editing: true });
    else if (module === 'chat') {
      select('new');
      setRevision((value) => value + 1);
    } else if (module === 'agents') open({ type: 'agent', id: 'new' });
    else open({ type: 'create', module });
  };
  const needsYou = runs.filter((run) => run.state === '需要你').length + 1;
  const headerLead =
    mobile || collapsed ? (
      <IconButton
        label={mobile ? '打开导航' : '展开目录'}
        onClick={() => (mobile ? setDrawer(true) : setCollapsed(false))}
      >
        {mobile ? <MenuIcon size={19} /> : <PanelLeftOpen size={18} />}
      </IconButton>
    ) : null;
  const context = {
    module,
    records,
    setRecords,
    navigate,
    selection,
    select,
    scope,
    setScope,
    openRecord: (item: RecordItem) => open({ type: 'record', item, editing: false }),
    openDocument: (id: string) => open({ type: 'document', id }),
    openAgent: (id: string, tab?: string) => open({ type: 'agent', id, tab }),
    openRun: (id: string) => open({ type: 'run', id }),
    openProvider: (capability: Capability, personal = false) => open({ type: 'provider', capability, personal }),
    openPanel: (title: string, content: ReactNode) => open({ type: 'content', title, content }),
    confirm: setConfirmation,
    notify,
    theme,
    setTheme,
    density,
    setDensity,
    mobile,
    headerLead,
    needsYou,
    reset,
    newItem,
    marks,
    mark,
  };
  const dark = theme === 'dark' || (theme === 'system' && systemDark);

  let panelTitle = '';
  let panelContent: ReactNode = null;
  let panelWide = false;
  let panelHelp: ReactNode = null;
  if (panel?.type === 'record') {
    const existing = records.some((item) => item.id === panel.item.id);
    panelTitle = existing ? panel.item.title : '添加记录';
    panelContent = (
      <RecordDrawer
        key={panel.item.id}
        item={panel.item}
        editing={panel.editing}
        onEdit={() => setPanel({ ...panel, editing: true })}
        onDirty={setDirty}
        onCancel={() => {
          if (!existing) return close();
          setDirty(false);
          setPanel({ ...panel, editing: false });
        }}
        onSave={(item) => {
          setRecords((value) => saveRecord(value, item));
          setPanel({ type: 'record', item, editing: false });
          setDirty(false);
          notify('记录已保存');
        }}
      />
    );
  }
  if (panel?.type === 'document') {
    const doc = documents.find((item) => item.id === panel.id)!;
    panelTitle = doc.title;
    panelContent = <DocumentDetail key={doc.id} document={doc} onSaved={() => notify('文档已保存')} />;
  }
  if (panel?.type === 'agent') {
    if (panel.id === 'new') {
      panelTitle = '新建 Agent';
      panelContent = (
        <NewAgentForm
          onCreate={(name) => {
            setPanel(null);
            notify(`已创建「${name}」`);
          }}
        />
      );
    } else {
      const agent = agents.find((item) => item.id === panel.id)!;
      panelTitle = agent.name;
      panelWide = true;
      panelContent = <AgentProfile agent={agent} initialTab={panel.tab} />;
    }
  }
  if (panel?.type === 'run') {
    const run = runs.find((item) => item.id === panel.id)!;
    panelTitle = run.title;
    panelContent = <RunDetail run={run} />;
  }
  if (panel?.type === 'provider') {
    const meta = capabilities.find((item) => item.id === panel.capability)!;
    panelContent = <ProviderDrawer capability={panel.capability} personal={panel.personal} />;
    panelTitle = panel.personal ? `我的${meta.label}` : meta.label;
    panelHelp = meta.hint;
  }
  if (panel?.type === 'create') {
    panelTitle =
      { knowledge: '新建', apps: '新建应用', skills: '新建技能', admin: '邀请成员' }[panel.module as string] ?? '新建';
    panelContent = (
      <CreatePanel
        module={panel.module}
        onSave={(name) => {
          setPanel(null);
          notify(`已创建「${name}」`);
        }}
      />
    );
  }
  if (panel?.type === 'content') {
    panelTitle = panel.title;
    panelContent = panel.content;
  }

  return (
    <KitProvider locale="zh">
      <DesignContext.Provider value={context}>
        <div className="preview-workspace">
          <header className="preview-toolbar">
            <a className="preview-brand" href="#chat">
              <GreenhouseMark /> <strong>Design</strong>
              <span>V2</span>
            </a>
            <div className="preview-controls">
              <div className="preview-tabs">
                <button aria-pressed={module !== 'components'} onClick={() => navigate('chat')}>
                  页面
                </button>
                <button aria-pressed={module === 'components'} onClick={() => navigate('components')}>
                  组件
                </button>
              </div>
              <NativeSelect
                label="预览页面"
                value={modules.find((item) => item.id === module)!.label}
                options={modules
                  .filter((item) => item.id !== 'components')
                  .map((item) => item.label)
                  .concat(module === 'components' ? ['组件'] : [])}
                onChange={(label) => navigate(modules.find((item) => item.label === label)!.id)}
              />
              <div className="preview-devices">
                <IconButton label="桌面预览" aria-pressed={viewport === '桌面'} onClick={() => setViewport('桌面')}>
                  <Columns3 size={17} />
                </IconButton>
                <IconButton label="手机预览" aria-pressed={viewport === '手机'} onClick={() => setViewport('手机')}>
                  <Smartphone size={17} />
                </IconButton>
              </div>
              <IconButton label={dark ? '切换浅色' : '切换深色'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
                {dark ? <Sun size={17} /> : <Moon size={17} />}
              </IconButton>
              <Button kind="ghost" onClick={reset}>
                重置
              </Button>
            </div>
            <span className="preview-caption">模拟数据 · 无需后端</span>
          </header>
          <div className={`stage ${mobile ? 'mobile-stage' : ''}`}>
            <div
              className={`product-window ${density === '紧凑' ? 'compact' : ''}`}
              data-theme={dark ? 'dark' : 'light'}
              data-narrow={mobile || undefined}
              data-floating-boundary
              data-testid="product-window"
            >
              <div className="product-background" inert={panel !== null || undefined}>
                {module === 'login' ? (
                  <LoginPage
                    onLogin={() => {
                      navigate('chat', 'main');
                      notify('欢迎回来');
                    }}
                  />
                ) : (
                  <>
                    {!mobile && <Rail onLogout={() => navigate('login')} />}
                    {mobile && drawer && (
                      <button className="nav-scrim" aria-label="关闭导航" onClick={() => setDrawer(false)} />
                    )}
                    {(mobile ? drawer : !collapsed) && (
                      <aside className={`context-sidebar ${mobile ? 'open' : ''}`} aria-label="模块目录">
                        <ModuleSidebar onCollapse={() => setCollapsed(true)} onClose={() => setDrawer(false)} />
                        {mobile && <MobileModuleBar />}
                      </aside>
                    )}
                    <main className="main-area" key={`${module}-${revision}`}>
                      {module === 'chat' ? (
                        <ChatPage key={selection} />
                      ) : module === 'components' ? (
                        <ComponentLab />
                      ) : (
                        <Page module={module} />
                      )}
                    </main>
                  </>
                )}
              </div>
              {panel && (
                <Overlay
                  key={panel.type === 'record' ? panel.item.id : panelTitle}
                  title={panelTitle}
                  help={panelHelp}
                  wide={panelWide}
                  beforeClose={mayClose}
                  onClose={() => setPanel(null)}
                >
                  {panelContent}
                </Overlay>
              )}
              {confirmDiscard && (
                <ConfirmDialog
                  title="放弃修改？"
                  cancelLabel="继续编辑"
                  confirmLabel="放弃修改"
                  danger
                  onCancel={() => setConfirmDiscard(false)}
                  onConfirm={() => {
                    setPanel(null);
                    setDirty(false);
                    setConfirmDiscard(false);
                  }}
                >
                  未保存的内容会丢失。
                </ConfirmDialog>
              )}
              {confirmation && (
                <ConfirmDialog
                  title={confirmation.title}
                  cancelLabel={confirmation.cancelLabel}
                  confirmLabel={confirmation.confirmLabel}
                  danger={confirmation.danger}
                  onCancel={() => setConfirmation(null)}
                  onConfirm={() => {
                    setConfirmation(null);
                    confirmation.onConfirm();
                  }}
                >
                  {confirmation.body}
                </ConfirmDialog>
              )}
              {notice && <Toast text={notice.text} action={notice.action} onClose={() => setNotice(null)} />}
            </div>
          </div>
          <footer className="preview-footer">
            <span>Native Haven</span>
            <span>选择页面、主题和设备，体验同一套组件。</span>
          </footer>
        </div>
      </DesignContext.Provider>
    </KitProvider>
  );
}
