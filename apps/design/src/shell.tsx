/**
 * App shell: the 64px global rail and the module column (docs/design-system/layout.md).
 *
 * Selection keys per module (the `selection` string in context):
 *   chat           main · agent:<id> · room:<id> · chat:<title> · new · archived
 *   knowledge      folder:<name> · doc:<id> · archived           (scope lives in `scope`)
 *   tables         view:<base>/<table>/<view>
 *   apps           center · app:<id>
 *   skills         全部 · 团队 · 我的
 *   agents         我的 · 公开 · 已归档
 *   runs           运行中 · 定时 · 已结束
 *   notifications  需要你 · 全部
 *   settings/admin a section name
 *   components     lab:<index>
 *
 * Every row and rail button has a right-click menu (also Shift F10 and a long press);
 * the same actions sit in the item's own "⋯" once it is open.
 */

import { useState, type ReactNode } from 'react';
import {
  Activity,
  Archive,
  Bell,
  BellOff,
  BookOpen,
  Boxes,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  GanttChart,
  Hash,
  KeyRound,
  LayoutGrid,
  Link2,
  LogOut,
  MessageSquare,
  MonitorPlay,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  Table2,
  Trash2,
  Upload,
  User,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import {
  Button,
  IconButton,
  Menu,
  SearchInput,
  Segmented,
  Tooltip,
  useContextMenu,
  type MenuEntry,
} from '@greenhouse/ui/kit';
import { useDesign } from './context';
import {
  agents,
  apps,
  chats,
  createLabel,
  documents,
  folders,
  moduleLabel,
  rooms,
  type AgentItem,
  type ModuleId,
} from './data';

export const railIcons: Record<'chat' | 'knowledge' | 'tables' | 'apps', LucideIcon> = {
  chat: MessageSquare,
  knowledge: BookOpen,
  tables: Table2,
  apps: Boxes,
};

export const settingsSections: { name: string; icon: LucideIcon }[] = [
  { name: '账号', icon: User },
  { name: '通知', icon: Bell },
  { name: '连接', icon: Link2 },
  { name: '密码库', icon: KeyRound },
  { name: '我的服务', icon: Server },
  { name: '外部访问', icon: Shield },
];
export const adminSections: { name: string; icon: LucideIcon }[] = [
  { name: '成员与分组', icon: Users },
  { name: '服务', icon: Server },
  { name: '用量', icon: Activity },
  { name: '连接器', icon: Link2 },
  { name: '外部访问', icon: Shield },
  { name: '公开 Agents', icon: Sparkles },
  { name: '品牌', icon: LayoutGrid },
];
export const labSections = ['基础', '导航', '按钮', '表单', '数据', '反馈', '弹框', '对话'];

export const defaultSelection: Record<ModuleId, string> = {
  chat: 'main',
  knowledge: 'folder:产品',
  tables: 'view:产品计划/任务/表格',
  apps: 'center',
  skills: '全部',
  agents: '我的',
  runs: '运行中',
  notifications: '需要你',
  settings: '账号',
  admin: '成员与分组',
  login: '',
  components: 'lab:0',
  surfaces: '',
};

const icon = (Icon: LucideIcon) => <Icon size={15} />;

/** The actions of each kind of row: its right-click menu and its "⋯" share one list. */
export function useRowMenus() {
  const { marks, mark, notify, navigate, openAgent, select, newItem, mobile } = useDesign();
  const toggle = (kind: 'muted' | 'pinned', key: string, label: string, Icon: LucideIcon): MenuEntry => ({
    label,
    icon: icon(Icon),
    checked: marks[kind].includes(key),
    onClick: () => mark(kind, key),
  });
  const hide = (key: string, done: string) => {
    mark('hidden', key, true);
    notify(done, { label: '撤销', onClick: () => mark('hidden', key, false) });
  };
  const copyLink = { label: '复制链接', icon: icon(Link2), onClick: () => notify('已复制链接') };
  const rename = { label: '重命名', icon: icon(Pencil), onClick: () => notify('在原处输入新名字') };
  return {
    agent: (agent: AgentItem): MenuEntry[] => {
      const key = `agent:${agent.id}`;
      const main = agent.kind === '主 Agent';
      return [
        {
          label: '新会话',
          icon: icon(Plus),
          onClick: () => (main ? navigate('chat', 'new') : notify(`和${agent.name}的新会话`)),
        },
        { label: '查看资料', icon: icon(User), onClick: () => openAgent(agent.id) },
        { label: '电脑', icon: icon(MonitorPlay), onClick: () => openAgent(agent.id, '电脑') },
        '-',
        toggle('muted', key, '静音通知', BellOff),
        { label: '标为已读', icon: icon(CheckCheck), onClick: () => mark('read', key, true) },
        ...(main
          ? []
          : ([
              '-',
              { label: '归档', icon: icon(Archive), onClick: () => hide(key, `已归档「${agent.name}」`) },
            ] as const)),
      ];
    },
    room: (id: string): MenuEntry[] => {
      const key = `room:${id}`;
      return [
        copyLink,
        toggle('muted', key, '静音通知', BellOff),
        { label: '标为已读', icon: icon(CheckCheck), onClick: () => mark('read', key, true) },
        rename,
        '-',
        { label: '离开房间', icon: icon(LogOut), danger: true, onClick: () => hide(key, '已离开房间') },
      ];
    },
    chat: (title: string, exportMarkdown?: () => void): MenuEntry[] => {
      const key = `chat:${title}`;
      const pinned = marks.pinned.includes(key);
      return [
        { label: pinned ? '取消置顶' : '置顶', icon: icon(pinned ? PinOff : Pin), onClick: () => mark('pinned', key) },
        rename,
        copyLink,
        {
          label: '导出 Markdown',
          icon: icon(Download),
          onClick: exportMarkdown ?? (() => notify(`已导出「${title}」`)),
        },
        '-',
        {
          label: '删除',
          icon: icon(Trash2),
          danger: true,
          onClick: () => {
            hide(key, `已删除「${title}」`);
            select('main');
          },
        },
      ];
    },
    folder: (name: string): MenuEntry[] => [
      { label: '新文档', icon: icon(FilePlus), onClick: newItem },
      { label: '新文件夹', icon: icon(FolderPlus), onClick: newItem },
      rename,
      '-',
      { label: '删除', icon: icon(Trash2), danger: true, onClick: () => notify(`删除「${name}」前会再确认一次`) },
    ],
    doc: (title: string): MenuEntry[] => [
      copyLink,
      rename,
      { label: '移动到…', icon: icon(FolderInput), onClick: () => notify('选择目标文件夹') },
      '-',
      {
        label: '删除',
        icon: icon(Trash2),
        danger: true,
        onClick: () => notify(`已删除「${title}」`, { label: '撤销', onClick: () => notify('已恢复') }),
      },
    ],
    table: (name: string, kind: 'base' | 'table' | 'view'): MenuEntry[] =>
      mobile
        ? [{ label: '查看配置', onClick: () => select(kind === 'view' ? 'config:视图配置' : 'config:字段配置') }]
        : [
            ...(kind === 'view'
              ? []
              : [
                  {
                    label: kind === 'base' ? '新建表格' : '新建视图',
                    icon: icon(Plus),
                    onClick: () => notify(kind === 'base' ? '新建表格' : '选择视图类型'),
                  },
                ]),
            rename,
            ...(kind === 'base'
              ? []
              : [{ label: '复制', icon: icon(Copy), onClick: () => notify(`已复制「${name}」`) }]),
            '-',
            { label: '删除', icon: icon(Trash2), danger: true, onClick: () => notify(`删除「${name}」前会再确认一次`) },
          ],
    app: (app: (typeof apps)[number]): MenuEntry[] => [
      { label: mobile ? '查看搭建器' : '编辑应用', icon: icon(Pencil), onClick: () => select(`builder:${app.id}`) },
      copyLink,
      { label: '取消置顶', icon: icon(PinOff), onClick: () => notify(`已取消置顶「${app.name}」`) },
      '-',
      { label: '删除', icon: icon(Trash2), danger: true, onClick: () => notify(`删除「${app.name}」前会再确认一次`) },
    ],
  };
}

/** Quick actions on a rail button's right-click menu. */
function useRailMenus(): Partial<Record<ModuleId, MenuEntry[]>> {
  const { navigate, notify, openAgent, newItem } = useDesign();
  const go = (module: ModuleId, selection?: string) => () => navigate(module, selection);
  return {
    chat: [
      { label: '新会话', icon: icon(Plus), onClick: go('chat', 'new') },
      { label: '新房间', icon: icon(Hash), onClick: go('chat', 'room:new') },
      { label: '新建 Agent', icon: icon(Sparkles), onClick: () => openAgent('new') },
      '-',
      { label: '全部标为已读', icon: icon(CheckCheck), onClick: () => notify('已全部标为已读') },
    ],
    knowledge: [
      { label: '新文档', icon: icon(FilePlus), onClick: newItem },
      { label: '上传文件', icon: icon(Upload), onClick: newItem },
      { label: '新文件夹', icon: icon(FolderPlus), onClick: newItem },
    ],
    tables: [
      { label: '新建表格', icon: icon(Plus), onClick: () => notify('新建表格') },
      { label: '从模板新建', icon: icon(LayoutGrid), onClick: () => notify('选择模板') },
      { label: '导入 CSV', icon: icon(Upload), onClick: () => notify('选择 CSV 文件') },
    ],
    apps: [
      { label: '新建应用', icon: icon(Plus), onClick: () => notify('新建应用') },
      { label: '应用中心', icon: icon(LayoutGrid), onClick: go('apps', 'center') },
    ],
    runs: [
      { label: '运行中', icon: icon(Activity), onClick: go('runs', '运行中') },
      { label: '定时', icon: icon(Activity), onClick: go('runs', '定时') },
      { label: '已结束', icon: icon(Activity), onClick: go('runs', '已结束') },
    ],
    notifications: [
      { label: '全部标为已读', icon: icon(CheckCheck), onClick: () => notify('已全部标为已读') },
      { label: '通知设置', icon: icon(Settings), onClick: go('settings', '通知') },
    ],
  };
}

function RailItem({
  id,
  Icon,
  badge,
  menu,
}: {
  id: ModuleId;
  Icon: LucideIcon;
  badge?: ReactNode;
  menu?: MenuEntry[];
}) {
  const { module, navigate } = useDesign();
  const context = useContextMenu(menu ?? [], `${moduleLabel(id)}的快捷操作`);
  return (
    <>
      <Tooltip label={moduleLabel(id)} side="right">
        <button
          className={`rail-item ${module === id ? 'active' : ''}`}
          aria-label={moduleLabel(id)}
          aria-current={module === id ? 'page' : undefined}
          onClick={() => navigate(id)}
          {...(menu ? context.handlers : {})}
        >
          <Icon size={20} strokeWidth={1.75} />
          {badge}
        </button>
      </Tooltip>
      {context.menu}
    </>
  );
}

export function Rail({ onLogout }: { onLogout: () => void }) {
  const { module, navigate, needsYou, runs } = useDesign();
  const menus = useRailMenus();
  const running = runs.some((run) => run.state === '运行中');
  return (
    <nav className="global-rail" aria-label="主导航">
      <Tooltip label="回到主线" side="right">
        <button className="logo-button" aria-label="回到主线" onClick={() => navigate('chat', 'main')}>
          <GreenhouseMark />
        </button>
      </Tooltip>
      <div className="rail-primary">
        {(['chat', 'knowledge', 'tables', 'apps'] as const).map((id) => (
          <RailItem key={id} id={id} Icon={railIcons[id]} menu={menus[id]} />
        ))}
        <Menu
          className={`rail-menu ${['skills', 'agents'].includes(module) ? 'active' : ''}`}
          label="更多"
          align="start"
          trigger={<MoreHorizontal size={20} strokeWidth={1.75} />}
          items={[
            { label: '技能', icon: icon(Sparkles), onClick: () => navigate('skills') },
            { label: 'Agents', icon: icon(User), onClick: () => navigate('agents') },
          ]}
        />
      </div>
      <div className="rail-secondary">
        <RailItem
          id="runs"
          Icon={Activity}
          menu={menus.runs}
          badge={running ? <span className="rail-dot" aria-label="有运行中的工作" /> : undefined}
        />
        <RailItem
          id="notifications"
          Icon={Bell}
          menu={menus.notifications}
          badge={
            needsYou > 0 ? (
              <span className="rail-count" aria-label={`${needsYou} 件需要你`}>
                {needsYou}
              </span>
            ) : undefined
          }
        />
        <Menu
          className="rail-menu account-menu"
          label="账户"
          align="start"
          trigger={<span className="member-avatar">林</span>}
          items={[
            { label: '设置', icon: icon(Settings), onClick: () => navigate('settings') },
            { label: '管理', icon: icon(Shield), onClick: () => navigate('admin') },
            '-',
            { label: '退出登录', icon: icon(LogOut), onClick: onLogout },
          ]}
        />
      </div>
    </nav>
  );
}

function Row({
  icon: leading,
  plant,
  title,
  active,
  signal,
  indent = 0,
  expanded,
  variant,
  menu,
  onClick,
}: {
  icon?: ReactNode;
  plant?: AgentItem['plant'];
  title: string;
  active?: boolean;
  signal?: ReactNode;
  indent?: number;
  /** Only rows that expand get a chevron. */
  expanded?: boolean;
  /** `main`: the main Agent, larger; `quiet`: a secondary link row. */
  variant?: 'main' | 'quiet';
  menu?: MenuEntry[];
  onClick: () => void;
}) {
  const context = useContextMenu(menu ?? [], `${title}的操作`);
  return (
    <>
      <button
        className={`sidebar-item ${variant ?? ''} ${active ? 'selected' : ''} ${context.open ? 'menu-open' : ''}`}
        style={indent ? { paddingLeft: 8 + indent * 16 } : undefined}
        aria-current={active ? 'true' : undefined}
        aria-expanded={expanded}
        onClick={onClick}
        {...(menu ? context.handlers : {})}
      >
        {expanded !== undefined && (
          <span className="chevron">{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        )}
        {plant ? <PlantAvatar plant={plant} size={variant === 'main' ? 36 : 20} animate={false} /> : leading}
        <span className="sidebar-item-title">{title}</span>
        {signal}
      </button>
      {context.menu}
    </>
  );
}
function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="sidebar-section">
      <div className="sidebar-section-title">
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}
const match = (query: string, ...values: string[]) =>
  !query || values.some((value) => value.toLowerCase().includes(query.toLowerCase()));

/** Right-side signal: a count when something needs you, otherwise a dot; muted rows show a bell. */
function signalFor(
  key: string,
  marks: { muted: string[]; read: string[] },
  state: { needs?: number; running?: boolean; unread?: boolean },
) {
  if (state.needs) return <span className="count warning">{state.needs}</span>;
  if (marks.muted.includes(key)) return <BellOff size={13} className="row-muted" aria-label="已静音" />;
  if (state.running) return <span className="running-dot" aria-label="运行中" />;
  if (state.unread && !marks.read.includes(key)) return <span className="unread-dot" aria-label="未读" />;
  return undefined;
}

/** Agents sit at the top without a heading; the main Agent is larger. Lists never preview messages. */
function ChatList({ query }: { query: string }) {
  const { selection, select, marks, requests } = useDesign();
  const menus = useRowMenus();
  const [earlier, setEarlier] = useState(false);
  const [main, ...rest] = agents;
  const others = rest.filter((agent) => !marks.hidden.includes(`agent:${agent.id}`) && match(query, agent.name));
  const visible = (title: string) => !marks.hidden.includes(`chat:${title}`) && match(query, title);
  const pinned = [...chats.pinned, ...chats.today, ...chats.earlier].filter(
    (title) => marks.pinned.includes(`chat:${title}`) && visible(title),
  );
  const unpinned = (titles: string[]) =>
    titles.filter((title) => !marks.pinned.includes(`chat:${title}`) && visible(title));
  const chatRow = (title: string, Icon: LucideIcon, indent = 0) => (
    <Row
      key={title}
      icon={<Icon size={14} />}
      title={title}
      indent={indent}
      active={selection === `chat:${title}`}
      menu={menus.chat(title)}
      onClick={() => select(`chat:${title}`)}
    />
  );
  return (
    <>
      <div className="agent-rows">
        {match(query, main.name, '主线') && (
          <Row
            variant="main"
            plant={main.plant}
            title={main.name}
            active={selection === 'main'}
            menu={menus.agent(main)}
            signal={signalFor(`agent:${main.id}`, marks, {
              needs: requests.filter((item) => item.conversation === 'main' && item.state === 'pending').length,
            })}
            onClick={() => select('main')}
          />
        )}
        {others.map((agent) => (
          <Row
            key={agent.id}
            plant={agent.plant}
            title={agent.name}
            active={selection === `agent:${agent.id}`}
            menu={menus.agent(agent)}
            signal={signalFor(`agent:${agent.id}`, marks, {
              needs: requests.filter((item) => item.agent === agent.name && item.state === 'pending').length,
              running: agent.status === '运行中',
            })}
            onClick={() => select(`agent:${agent.id}`)}
          />
        ))}
      </div>
      <Section
        title="房间"
        actions={
          <IconButton label="新建房间" size="sm" onClick={() => select('room:new')}>
            <Plus size={14} />
          </IconButton>
        }
      >
        {rooms
          .filter((room) => !marks.hidden.includes(`room:${room.id}`) && match(query, room.name))
          .map((room) => (
            <Row
              key={room.id}
              icon={room.id.startsWith('dm') ? <User size={15} /> : <Hash size={15} />}
              title={room.name}
              active={selection === `room:${room.id}`}
              menu={menus.room(room.id)}
              signal={signalFor(`room:${room.id}`, marks, { unread: room.unread })}
              onClick={() => select(`room:${room.id}`)}
            />
          ))}
      </Section>
      <Section title="会话">
        {pinned.map((title) => chatRow(title, Pin))}
        {unpinned(chats.today).map((title) => chatRow(title, MessageSquare))}
        <Row icon={<span />} title="更早" expanded={earlier || !!query} onClick={() => setEarlier(!earlier)} />
        {(earlier || query) && unpinned(chats.earlier).map((title) => chatRow(title, MessageSquare, 1))}
      </Section>
    </>
  );
}

function KnowledgeTree({ query }: { query: string }) {
  const { selection, select, scope, setScope } = useDesign();
  const menus = useRowMenus();
  const [open, setOpen] = useState<string[]>(['产品']);
  const visible = documents.filter(
    (doc) => (scope === '分享给我' ? false : doc.scope === scope) && match(query, doc.title),
  );
  return (
    <>
      <Segmented label="范围" items={['团队', '个人', '分享给我']} value={scope} onChange={setScope} />
      {scope === '分享给我' && <p className="muted small sidebar-note">还没有人分享给你。</p>}
      {folders.map((folder) => {
        const docs = visible.filter((doc) => doc.folder === folder);
        if (!docs.length && (query || scope !== '团队')) return null;
        const expanded = open.includes(folder) || !!query;
        return (
          <div key={folder}>
            <Row
              icon={<Folder size={15} />}
              title={folder}
              expanded={expanded}
              active={selection === `folder:${folder}`}
              menu={menus.folder(folder)}
              onClick={() => {
                select(`folder:${folder}`);
                setOpen((value) =>
                  value.includes(folder) ? value.filter((item) => item !== folder) : [...value, folder],
                );
              }}
            />
            {expanded &&
              docs.map((doc) => (
                <Row
                  key={doc.id}
                  icon={<FileText size={15} />}
                  title={doc.title}
                  indent={1}
                  active={selection === `doc:${doc.id}`}
                  menu={menus.doc(doc.title)}
                  onClick={() => select(`doc:${doc.id}`)}
                />
              ))}
          </div>
        );
      })}
    </>
  );
}

const bases = [
  {
    base: '产品计划',
    template: '项目',
    tables: [
      { name: '任务', views: ['表格', '看板', '时间线'] },
      { name: '里程碑', views: ['表格'] },
    ],
  },
  { base: 'IT 支持', template: '', tables: [{ name: '工单', views: ['表格', '看板'] }] },
];
const viewIcon = (view: string) =>
  view === '看板' ? <Columns3 size={14} /> : view === '时间线' ? <GanttChart size={14} /> : <Table2 size={14} />;

function TablesTree({ query }: { query: string }) {
  const { selection, select } = useDesign();
  const menus = useRowMenus();
  const [open, setOpen] = useState<string[]>(['产品计划', '产品计划/任务']);
  const toggle = (key: string) =>
    setOpen((value) => (value.includes(key) ? value.filter((item) => item !== key) : [...value, key]));
  return (
    <>
      {bases
        .filter((base) => match(query, base.base, ...base.tables.map((table) => table.name)))
        .map((base) => (
          <div key={base.base}>
            <Row
              icon={<LayoutGrid size={15} />}
              title={base.base}
              expanded={open.includes(base.base) || !!query}
              menu={menus.table(base.base, 'base')}
              onClick={() => toggle(base.base)}
            />
            {(open.includes(base.base) || query) &&
              base.tables.map((table) => {
                const key = `${base.base}/${table.name}`;
                return (
                  <div key={key}>
                    <Row
                      icon={<Table2 size={15} />}
                      title={table.name}
                      indent={1}
                      expanded={open.includes(key)}
                      menu={menus.table(table.name, 'table')}
                      onClick={() => toggle(key)}
                    />
                    {open.includes(key) &&
                      table.views.map((view) => (
                        <Row
                          key={view}
                          icon={viewIcon(view)}
                          title={view}
                          indent={2}
                          active={selection === `view:${key}/${view}`}
                          menu={menus.table(view, 'view')}
                          onClick={() => select(`view:${key}/${view}`)}
                        />
                      ))}
                  </div>
                );
              })}
          </div>
        ))}
    </>
  );
}

function AppsList({ query }: { query: string }) {
  const { selection, select } = useDesign();
  const menus = useRowMenus();
  return (
    <>
      <Row
        icon={<LayoutGrid size={15} />}
        title="应用中心"
        active={selection === 'center'}
        onClick={() => select('center')}
      />
      <Section title="置顶">
        {apps
          .filter((app) => app.pinned && match(query, app.name))
          .map((app) => (
            <Row
              key={app.id}
              icon={<Boxes size={15} />}
              title={app.name}
              active={selection === `app:${app.id}`}
              menu={menus.app(app)}
              onClick={() => select(`app:${app.id}`)}
            />
          ))}
      </Section>
    </>
  );
}

function FlatList({ items, icons }: { items: string[]; icons?: Record<string, ReactNode> }) {
  const { selection, select } = useDesign();
  const { needsYou, runs } = useDesign();
  const counts: Record<string, number> = {
    运行中: runs.filter((run) => ['运行中', '排队中'].includes(run.state)).length,
    需要你: needsYou,
  };
  return (
    <>
      {items.map((item) => (
        <Row
          key={item}
          icon={icons?.[item]}
          title={item}
          active={selection === item}
          signal={
            counts[item] ? (
              <span className={`count ${item === '需要你' ? 'warning' : ''}`}>{counts[item]}</span>
            ) : undefined
          }
          onClick={() => select(item)}
        />
      ))}
    </>
  );
}

export function ModuleSidebar({ onCollapse, onClose }: { onCollapse: () => void; onClose?: () => void }) {
  const { module, mobile, newItem, select, selection } = useDesign();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const create = createLabel[module];
  const sectionIcons = (list: { name: string; icon: LucideIcon }[]) =>
    Object.fromEntries(list.map(({ name, icon: Icon }) => [name, <Icon key={name} size={15} />]));
  return (
    <>
      <div className="sidebar-heading">
        {searching ? (
          <SearchInput
            label={`搜索${moduleLabel(module)}`}
            value={query}
            onChange={setQuery}
            autoFocus
            onEscape={() => setSearching(false)}
          />
        ) : (
          <h2>{moduleLabel(module)}</h2>
        )}
        <IconButton
          size="sm"
          label={searching ? '关闭搜索' : `搜索${moduleLabel(module)}`}
          onClick={() => {
            setSearching(!searching);
            setQuery('');
          }}
        >
          {searching ? <X size={16} /> : <Search size={16} />}
        </IconButton>
        {mobile ? (
          <IconButton label="关闭导航" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        ) : (
          <IconButton label="收起目录" size="sm" onClick={onCollapse}>
            <PanelLeftClose size={16} />
          </IconButton>
        )}
      </div>
      {create && (
        <Button className="sidebar-create" kind="primary" onClick={newItem}>
          <Plus size={16} />
          {create}
        </Button>
      )}
      <div className="sidebar-list">
        {module === 'chat' && <ChatList query={query} />}
        {module === 'knowledge' && <KnowledgeTree query={query} />}
        {module === 'tables' && <TablesTree query={query} />}
        {module === 'apps' && <AppsList query={query} />}
        {module === 'skills' && <FlatList items={['全部', '团队', '我的']} />}
        {module === 'agents' && <FlatList items={['我的', '公开', '已归档']} />}
        {module === 'runs' && <FlatList items={['运行中', '定时', '已结束']} />}
        {module === 'notifications' && <FlatList items={['需要你', '全部']} />}
        {module === 'settings' && (
          <FlatList items={settingsSections.map((item) => item.name)} icons={sectionIcons(settingsSections)} />
        )}
        {module === 'admin' && (
          <FlatList items={adminSections.map((item) => item.name)} icons={sectionIcons(adminSections)} />
        )}
        {module === 'components' &&
          labSections.map((title, index) => (
            <Row
              key={title}
              icon={<LayoutGrid size={15} />}
              title={title}
              active={selection === `lab:${index}`}
              onClick={() => {
                select(`lab:${index}`);
                document.getElementById(`lab-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
          ))}
      </div>
      {['chat', 'knowledge'].includes(module) && (
        <div className="sidebar-bottom">
          <Row
            icon={<Archive size={15} />}
            title="已归档"
            active={selection === 'archived'}
            onClick={() => select('archived')}
          />
        </div>
      )}
    </>
  );
}

/** Narrow screens: the drawer ends with the module bar, as in the native app. */
export function MobileModuleBar() {
  const { module, navigate } = useDesign();
  return (
    <nav className="mobile-module-bar" aria-label="模块">
      {(['chat', 'knowledge', 'tables', 'apps'] as const).map((id) => {
        const Icon = railIcons[id];
        return (
          <button key={id} aria-current={module === id ? 'page' : undefined} onClick={() => navigate(id)}>
            <Icon size={19} />
            <span>{moduleLabel(id)}</span>
          </button>
        );
      })}
      <Menu
        className="rail-menu mobile-more"
        label="更多"
        trigger={
          <>
            <MoreHorizontal size={19} />
            <span>更多</span>
          </>
        }
        items={[
          { label: '运行', onClick: () => navigate('runs') },
          { label: '技能', onClick: () => navigate('skills') },
          { label: 'Agents', onClick: () => navigate('agents') },
          '-',
          { label: '设置', onClick: () => navigate('settings') },
          { label: '管理', onClick: () => navigate('admin') },
        ]}
      />
    </nav>
  );
}
