import { useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  Boxes,
  Calendar,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  Grid2X2,
  KeyRound,
  Link2,
  List,
  Play,
  Plus,
  Server,
  Trash2,
} from 'lucide-react';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import {
  Badge,
  Button,
  Checkbox,
  Empty,
  Field,
  HelpHint,
  IconButton,
  Input,
  Menu,
  OverlayActions,
  SearchInput,
  Segmented,
  Select,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
} from '@greenhouse/ui/kit';
import { MiniChart, PageFrame, RequestCard, SectionTitle } from './components';
import { useDesign } from './context';
import {
  agents,
  apps,
  capabilities,
  connections,
  documents,
  downloadText,
  members,
  runs,
  schedules,
  skills,
  workspaceProviders,
  type ModuleId,
  type Status,
} from './data';

export function Page({ module }: { module: ModuleId }) {
  if (module === 'knowledge') return <KnowledgePage />;
  if (module === 'tables') return <TablesPage />;
  if (module === 'apps') return <AppsPage />;
  if (module === 'skills') return <SkillsPage />;
  if (module === 'agents') return <AgentsPage />;
  if (module === 'runs') return <RunsPage />;
  if (module === 'notifications') return <NotificationsPage />;
  if (module === 'settings') return <SettingsPage />;
  if (module === 'admin') return <AdminPage />;
  return <Empty />;
}

// ─── Knowledge ───

function KnowledgePage() {
  const { selection, scope, openDocument, notify } = useDesign();
  const [layout, setLayout] = useState('列表');
  if (selection === 'archived')
    return (
      <PageFrame title="已归档">
        <Empty title="没有归档的文档" description="归档的文档会在这里，可以随时恢复。" />
      </PageFrame>
    );
  if (selection.startsWith('doc:')) {
    const doc = documents.find((item) => item.id === selection.slice(4))!;
    return (
      <PageFrame
        title={doc.title}
        width="reading"
        badge={doc.scope === '个人' ? <Badge>个人</Badge> : undefined}
        actions={
          <>
            {doc.kind === '文档' && (
              <Button kind="primary" onClick={() => openDocument(doc.id)}>
                编辑
              </Button>
            )}
            <Menu
              items={[
                { label: '分享', onClick: () => notify('分享给成员或分组') },
                { label: '版本历史', onClick: () => notify('共 4 个版本') },
                { label: '导出 Markdown', onClick: () => downloadText(`${doc.title}.md`, doc.content) },
                { label: '归档', onClick: () => notify('已归档', { label: '撤销', onClick: () => notify('已恢复') }) },
              ]}
            />
          </>
        }
      >
        <p className="muted small doc-meta">
          {doc.folder} · 林杰 {doc.date}更新
        </p>
        <article className="document-content reading">
          {doc.content
            .split('\n\n')
            .map((part, index) => (index % 2 === 0 ? <h2 key={index}>{part}</h2> : <p key={index}>{part}</p>))}
        </article>
      </PageFrame>
    );
  }
  const folder = selection.startsWith('folder:') ? selection.slice(7) : '产品';
  const items = documents.filter((item) => item.folder === folder && item.scope === scope);
  return (
    <PageFrame
      title={folder}
      help="文档和文件放在同一个文件夹里。分享文件夹时，里面的内容一起分享。"
      actions={
        <>
          <IconButton
            label={layout === '列表' ? '网格视图' : '列表视图'}
            onClick={() => setLayout(layout === '列表' ? '网格' : '列表')}
          >
            {layout === '列表' ? <Grid2X2 size={17} /> : <List size={17} />}
          </IconButton>
          <Menu
            items={[
              { label: '分享文件夹', onClick: () => notify('分享给成员或分组') },
              { label: '导出', onClick: () => notify('已开始导出，完成后通知你') },
            ]}
          />
        </>
      }
    >
      {items.length ? (
        <div className={layout === '网格' ? 'document-grid' : 'list-card'}>
          {items.map((item) => (
            <button
              key={item.id}
              className={layout === '网格' ? 'document-card' : 'list-row'}
              onClick={() => openDocument(item.id)}
            >
              <span className="file-icon">{item.kind === '文档' ? <FileText size={20} /> : <File size={20} />}</span>
              <span className="grow">
                <strong>{item.title}</strong>
                <span className="muted small">{item.kind}</span>
              </span>
              <span className="muted small">{item.date}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty title="这个文件夹是空的" action={<Button>新建文档</Button>} />
      )}
    </PageFrame>
  );
}

// ─── Tables (the 项目 template replaces the v1 Projects module) ───

function TablesPage() {
  const { selection, select, newItem } = useDesign();
  const [, base, table, view] = selection.match(/^view:([^/]+)\/([^/]+)\/(.+)$/) ?? ['', '产品计划', '任务', '表格'];
  const views =
    base === '产品计划' && table === '任务'
      ? ['表格', '看板', '时间线']
      : base === 'IT 支持'
        ? ['表格', '看板']
        : ['表格'];
  const isTasks = base === '产品计划' && table === '任务';
  return (
    <PageFrame
      title={`${base} / ${table}`}
      width="canvas"
      help={base === '产品计划' ? '用「项目」模板创建：项目、任务、里程碑，带负责人、日期与依赖。' : undefined}
      actions={
        <>
          <Button kind="primary" onClick={newItem}>
            <Plus size={15} />
            添加记录
          </Button>
          <Menu
            items={[
              { label: '共享与权限', onClick: () => {} },
              { label: '自动化', onClick: () => {} },
              { label: '回收站', onClick: () => {} },
            ]}
          />
        </>
      }
    >
      {views.length > 1 && (
        <Tabs items={views} value={view} onChange={(next) => select(`view:${base}/${table}/${next}`)} label="视图" />
      )}
      {!isTasks ? (
        base === 'IT 支持' ? (
          <TicketsTable />
        ) : (
          <Empty title="还没有里程碑" action={<Button onClick={newItem}>添加记录</Button>} />
        )
      ) : view === '看板' ? (
        <Kanban />
      ) : view === '时间线' ? (
        <Timeline />
      ) : (
        <TablePage />
      )}
    </PageFrame>
  );
}

const tickets = [
  ['无法连接公司 Wi-Fi', '高', '待处理', '陈晓'],
  ['更新设计软件', '中', '待处理', '林雨'],
  ['申请共享盘权限', '低', '已完成', '陈晓'],
];
function TicketsTable() {
  const { openPanel } = useDesign();
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>问题摘要</th>
            <th>优先级</th>
            <th>状态</th>
            <th>处理人</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map(([title, priority, status, owner]) => (
            <tr key={title}>
              <td className="name-cell">
                <button
                  className="record-name"
                  onClick={() =>
                    openPanel(
                      title,
                      <p>
                        {owner} 负责 · {status}
                      </p>,
                    )
                  }
                >
                  <FileText size={16} />
                  <span>{title}</span>
                </button>
              </td>
              <td>
                <Badge tone={priority === '高' ? 'warning' : 'neutral'}>{priority}</Badge>
              </td>
              <td>
                <StatusBadge status={status} />
              </td>
              <td>{owner}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kanban() {
  const { records, setRecords, openRecord } = useDesign();
  return (
    <div className="kanban">
      {(['待处理', '进行中', '已完成'] as Status[]).map((status) => (
        <section className="kanban-column" key={status}>
          <div className="section-heading">
            <h3>{status}</h3>
            <span className="muted small">{records.filter((item) => item.status === status).length}</span>
          </div>
          {records
            .filter((item) => item.status === status)
            .map((item) => (
              <article className="task-card" key={item.id}>
                <div className="row">
                  <Badge tone={item.priority === '高' ? 'warning' : 'neutral'}>{item.priority}</Badge>
                  <Menu
                    label={`移动 ${item.title}`}
                    items={(['待处理', '进行中', '已完成'] as Status[])
                      .filter((next) => next !== status)
                      .map((next) => ({
                        label: `移到「${next}」`,
                        onClick: () =>
                          setRecords((value) =>
                            value.map((row) => (row.id === item.id ? { ...row, status: next } : row)),
                          ),
                      }))}
                  />
                </div>
                <button className="task-title" onClick={() => openRecord(item)}>
                  {item.title}
                </button>
                <div className="row small muted">
                  <Calendar size={14} />
                  {item.date.slice(5)}
                  <span className="push-right mini-avatar">{item.owner[0]}</span>
                </div>
              </article>
            ))}
        </section>
      ))}
    </div>
  );
}

function Timeline() {
  const { records, openRecord } = useDesign();
  const start = new Date('2026-10-08').getTime();
  const day = 86400000;
  const span = 14;
  const days = Array.from({ length: span / 2 }, (_, index) => new Date(start + index * 2 * day));
  return (
    <div className="timeline-wrap">
      <div className="timeline-heading">
        <span>任务</span>
        <div>
          {days.map((date) => (
            <span key={date.toISOString()}>
              {date.getMonth() + 1}/{date.getDate()}
            </span>
          ))}
        </div>
      </div>
      {[...records]
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((item) => {
          const left = ((new Date(item.start).getTime() - start) / day / span) * 100;
          const width = Math.max(
            6,
            ((new Date(item.date).getTime() - new Date(item.start).getTime()) / day / span) * 100,
          );
          return (
            <button className="timeline-row" key={item.id} onClick={() => openRecord(item)}>
              <span>{item.title}</span>
              <div>
                <span
                  className={`timeline-bar ${item.status === '已完成' ? 'done' : ''}`}
                  style={{ marginLeft: `${left}%`, width: `${width}%` }}
                >
                  {item.owner}
                </span>
              </div>
            </button>
          );
        })}
    </div>
  );
}

export function TablePage({ embedded = false }: { embedded?: boolean }) {
  const { records, setRecords, openRecord, notify, confirm } = useDesign();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('全部状态');
  const [sort, setSort] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('5');
  const [mobileGrid, setMobileGrid] = useState(false);
  const filtered = records
    .filter(
      (item) =>
        `${item.title} ${item.id} ${item.owner}`.toLowerCase().includes(search.toLowerCase()) &&
        (status === '全部状态' || item.status === status),
    )
    .sort((a, b) => (sort ? a.date.localeCompare(b.date) : 0));
  const pages = Math.max(1, Math.ceil(filtered.length / Number(pageSize)));
  const safePage = Math.min(page, pages);
  const shown = filtered.slice((safePage - 1) * Number(pageSize), safePage * Number(pageSize));
  const allChecked = shown.length > 0 && shown.every((item) => selected.includes(item.id));
  const selectOne = (id: string) =>
    setSelected((value) => (value.includes(id) ? value.filter((item) => item !== id) : [...value, id]));
  const remove = () => {
    const previous = records;
    setRecords((value) => value.filter((item) => !selected.includes(item.id)));
    setSelected([]);
    notify('记录已删除', {
      label: '撤销',
      onClick: () => {
        setRecords(previous);
        notify('已恢复记录');
      },
    });
  };
  return (
    <div className={`table-page ${embedded ? 'embedded' : ''}`}>
      <div className="table-toolbar">
        <SearchInput
          label="搜索记录"
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="搜索记录…"
        />
        <Select
          label="筛选状态"
          value={status}
          options={['全部状态', '待处理', '进行中', '已完成']}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <Button kind={sort ? 'secondary' : 'ghost'} aria-pressed={sort} onClick={() => setSort(!sort)}>
          <ArrowDown size={15} />
          截止日期
        </Button>
        <IconButton
          className="mobile-only"
          label={mobileGrid ? '切换记录列表' : '切换完整表格'}
          onClick={() => setMobileGrid(!mobileGrid)}
        >
          {mobileGrid ? <List size={17} /> : <Grid2X2 size={17} />}
        </IconButton>
      </div>
      {selected.length > 0 && (
        <div className="bulk-bar">
          <span>已选 {selected.length} 条</span>
          <Button
            kind="ghost"
            onClick={() => {
              setRecords((value) =>
                value.map((item) => (selected.includes(item.id) ? { ...item, status: '已完成' } : item)),
              );
              setSelected([]);
              notify('状态已更新');
            }}
          >
            <Check size={15} />
            标为已完成
          </Button>
          <Button
            kind="ghost"
            onClick={() =>
              confirm({
                title: `删除 ${selected.length} 条记录？`,
                body: '记录会进入回收站，30 天内可以恢复。',
                confirmLabel: '删除记录',
                danger: true,
                onConfirm: remove,
              })
            }
          >
            <Trash2 size={15} />
            删除
          </Button>
          <Button kind="ghost" className="push-right" onClick={() => setSelected([])}>
            取消选择
          </Button>
        </div>
      )}
      <div className={`data-table-wrap ${mobileGrid ? 'show-grid' : ''}`}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="check-cell">
                <Checkbox
                  aria-label="选择当前页所有记录"
                  checked={allChecked}
                  indeterminate={!allChecked && shown.some((item) => selected.includes(item.id))}
                  onChange={() =>
                    setSelected((value) =>
                      allChecked
                        ? value.filter((id) => !shown.some((item) => item.id === id))
                        : Array.from(new Set([...value, ...shown.map((item) => item.id)])),
                    )
                  }
                />
              </th>
              <th>名称</th>
              <th>状态</th>
              <th>负责人</th>
              <th>优先级</th>
              <th>截止日期</th>
              <th className="check-cell" />
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id} className={selected.includes(item.id) ? 'selected-row' : ''}>
                <td className="check-cell">
                  <Checkbox
                    aria-label={`选择 ${item.title}`}
                    checked={selected.includes(item.id)}
                    onChange={() => selectOne(item.id)}
                  />
                </td>
                <td className="name-cell">
                  <button className="record-name" onClick={() => openRecord(item)}>
                    <FileText size={16} />
                    <span>{item.title}</span>
                  </button>
                  <span className="mobile-record-meta">
                    <StatusBadge status={item.status} />
                    <span>{item.owner}</span>
                    <span>{item.date.slice(5)}</span>
                  </span>
                </td>
                <td>
                  <Select
                    size="sm"
                    label={`${item.title} 状态`}
                    value={item.status}
                    options={['待处理', '进行中', '已完成']}
                    onChange={(next) => {
                      setRecords((value) =>
                        value.map((row) => (row.id === item.id ? { ...row, status: next as Status } : row)),
                      );
                      notify('状态已更新');
                    }}
                  />
                </td>
                <td>
                  <span className="mini-avatar">{item.owner[0]}</span>
                  {item.owner}
                </td>
                <td>
                  <Badge tone={item.priority === '高' ? 'warning' : 'neutral'}>{item.priority}</Badge>
                </td>
                <td className="muted tabular">{item.date.slice(5).replace('-', ' / ')}</td>
                <td>
                  <Menu
                    label={`${item.title} 更多操作`}
                    items={[
                      { label: '打开', onClick: () => openRecord(item) },
                      {
                        label: '复制记录',
                        onClick: () => {
                          setRecords((value) => [
                            {
                              ...item,
                              id: `GH-${Math.max(...value.map((row) => Number(row.id.slice(3)))) + 1}`,
                              title: `${item.title}（副本）`,
                            },
                            ...value,
                          ]);
                          notify('记录已复制');
                        },
                      },
                    ]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && (
          <Empty
            title="没有匹配的记录"
            action={
              <Button
                onClick={() => {
                  setSearch('');
                  setStatus('全部状态');
                }}
              >
                清除筛选
              </Button>
            }
          />
        )}
      </div>
      <div className="table-footer">
        <span className="muted small">共 {filtered.length} 条</span>
        <div className="row">
          <Select
            size="sm"
            label="每页条数"
            value={pageSize}
            options={['5', '10', '20']}
            onChange={(value) => {
              setPageSize(value);
              setPage(1);
            }}
          />
          <IconButton label="上一页" size="sm" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>
            <ChevronLeft size={16} />
          </IconButton>
          <span className="small tabular">
            {safePage} / {pages}
          </span>
          <IconButton label="下一页" size="sm" disabled={safePage === pages} onClick={() => setPage(safePage + 1)}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

// ─── Apps ───

function AppsPage() {
  const { selection, select, openPanel, notify } = useDesign();
  const [scope, setScope] = useState('我的');
  if (selection.startsWith('app:')) {
    const app = apps.find((item) => item.id === selection.slice(4))!;
    return <AppRuntime app={app} />;
  }
  return (
    <PageFrame title="应用中心" help="应用是基于表格搭建的页面，按人或分组发放。数据仍然保存在表格里。">
      <Segmented label="范围" items={['我的', '分享给我']} value={scope} onChange={setScope} />
      <SectionTitle title="置顶" />
      <div className="app-grid">
        {apps
          .filter((app) => app.pinned)
          .map((app) => (
            <button className="app-card" key={app.id} onClick={() => select(`app:${app.id}`)}>
              <span className="app-icon">
                <Boxes size={20} />
              </span>
              <strong>{app.name}</strong>
              <span className="muted small">{app.description}</span>
            </button>
          ))}
      </div>
      <SectionTitle title="全部" />
      <div className="list-card">
        {apps.map((app) => (
          <div className="list-row" key={app.id}>
            <span className="file-icon">
              <Boxes size={18} />
            </span>
            <button className="grow plain" onClick={() => select(`app:${app.id}`)}>
              <strong>{app.name}</strong>
              <span className="muted small">
                基于「{app.base}」· {app.owner}
              </span>
            </button>
            <Menu
              items={[
                { label: '打开', onClick: () => select(`app:${app.id}`) },
                {
                  label: '编辑应用',
                  onClick: () =>
                    openPanel('编辑应用', <p>页面、卡片、角色与受众在搭建器里编辑；发布前可以按角色预览。</p>),
                },
                { label: app.pinned ? '取消置顶' : '置顶', onClick: () => notify('已更新') },
              ]}
            />
          </div>
        ))}
      </div>
    </PageFrame>
  );
}
function AppRuntime({ app }: { app: (typeof apps)[number] }) {
  const { openPanel, notify } = useDesign();
  const [page, setPage] = useState('我的工单');
  return (
    <PageFrame
      title={app.name}
      badge={<Badge>应用</Badge>}
      actions={
        <>
          <Button
            kind="primary"
            onClick={() => openPanel('提交工单', <TicketForm onSubmit={() => notify('已提交，处理人会收到通知')} />)}
          >
            提交工单
          </Button>
          <Menu items={[{ label: '编辑应用', onClick: () => notify('打开搭建器') }]} />
        </>
      }
    >
      <Tabs items={['我的工单', '全部工单', '统计']} value={page} onChange={setPage} label="应用页面" />
      {page === '统计' ? <MiniChart title="本周新工单" /> : <TicketsTable />}
    </PageFrame>
  );
}

function TicketForm({ onSubmit }: { onSubmit: () => void }) {
  const formId = useId();
  const [priority, setPriority] = useState('中');
  return (
    <form
      id={formId}
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Field label="问题摘要" required>
        <Input data-autofocus />
      </Field>
      <Field label="优先级">
        <Select label="优先级" value={priority} options={['高', '中', '低']} onChange={setPriority} />
      </Field>
      <OverlayActions>
        <Button kind="primary" type="submit" form={formId}>
          提交工单
        </Button>
      </OverlayActions>
    </form>
  );
}

// ─── Skills ───

function SkillsPage() {
  const { selection, openPanel, navigate } = useDesign();
  const shown = skills.filter((skill) => selection === '全部' || skill.scope === selection);
  return (
    <PageFrame
      title="技能"
      help="技能是可复用的做法。模板只有说明和变量；技能包可以带文件和脚本，有版本与安全扫描。在输入框里用 / 调用。"
    >
      <div className="list-card">
        {shown.map((skill) => (
          <button
            className="list-row"
            key={skill.id}
            onClick={() =>
              openPanel(
                skill.name,
                <SkillDetail
                  skill={skill}
                  onUse={(text) => {
                    sessionStorage.setItem('greenhouse-design-draft', text);
                    navigate('chat', 'new');
                  }}
                />,
              )
            }
          >
            <span className="file-icon">
              <FileText size={18} />
            </span>
            <span className="grow">
              <strong>{skill.name}</strong>
              <span className="muted small">{skill.description}</span>
            </span>
            <Badge>{skill.kind}</Badge>
            <span className="muted small tabular">{skill.version}</span>
          </button>
        ))}
      </div>
    </PageFrame>
  );
}
function SkillDetail({ skill, onUse }: { skill: (typeof skills)[number]; onUse: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({ 项目: '产品改版', 风格: '简洁' });
  const formId = useId();
  return (
    <form
      id={formId}
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        onUse(`/${skill.name} ${Object.values(values).join(' · ')}`);
      }}
    >
      <div className="row">
        <Badge>{skill.kind}</Badge>
        <span className="muted small">
          {skill.scope} · {skill.version}
        </span>
        {'requires' in skill && <Badge tone="info">{skill.requires}</Badge>}
      </div>
      <p>{skill.description}</p>
      {'variables' in skill &&
        skill.variables?.map((variable, index) => (
          <Field label={variable} key={variable}>
            <Input
              data-autofocus={index === 0 || undefined}
              value={values[variable] ?? ''}
              onChange={(event) => setValues((value) => ({ ...value, [variable]: event.target.value }))}
            />
          </Field>
        ))}
      <OverlayActions>
        <Button kind="primary" type="submit" form={formId}>
          在对话中使用
        </Button>
      </OverlayActions>
    </form>
  );
}

// ─── Agents directory ───

function AgentsPage() {
  const { selection, openAgent } = useDesign();
  const shown =
    selection === '公开'
      ? agents.filter((agent) => agent.kind === '公开')
      : selection === '已归档'
        ? []
        : agents.filter((agent) => agent.owner === '林杰');
  return (
    <PageFrame title="Agents" help="你的 Agent 只属于你。发布后，同事可以和它对话，但看不到你的私有资料与对话。">
      {shown.length ? (
        <div className="agent-grid">
          {shown.map((agent) => (
            <button className="agent-card" key={agent.id} onClick={() => openAgent(agent.id)}>
              <PlantAvatar plant={agent.plant} size={64} animate={false} />
              <h2>{agent.name}</h2>
              <span className="muted small">{agent.role}</span>
              <StatusBadge status={agent.status} />
            </button>
          ))}
        </div>
      ) : (
        <Empty title="没有归档的 Agent" />
      )}
    </PageFrame>
  );
}

// ─── Runs ───

function RunsPage() {
  const { selection, openRun, notify } = useDesign();
  const [agent, setAgent] = useState('全部 Agent');
  if (selection === '定时')
    return (
      <PageFrame title="定时" help="定时属于某个 Agent，在 Agent 资料的「定时」里添加，也可以在对话里直接说。">
        <div className="list-card">
          {schedules.map((item) => (
            <div className="list-row" key={item.id}>
              <Calendar size={18} />
              <span className="grow">
                <strong>{item.title}</strong>
                <span className="muted small">
                  {item.agent} · {item.rule} · 下次 {item.next}
                </span>
              </span>
              <Button kind="ghost" onClick={() => notify(`已开始「${item.title}」`)}>
                <Play size={14} />
                立即运行
              </Button>
              <Switch label={`启用 ${item.title}`} checked={item.enabled} onChange={() => notify('已更新')} />
            </div>
          ))}
        </div>
      </PageFrame>
    );
  const done = selection === '已结束';
  const shown = runs.filter(
    (run) =>
      (done ? ['已完成', '失败', '已取消'] : ['运行中', '排队中', '需要你']).includes(run.state) &&
      (agent === '全部 Agent' || run.agent === agent),
  );
  return (
    <PageFrame
      title={done ? '已结束' : '运行中'}
      help="Agent 在后台做的每一件事都在这里：来自对话、定时或表格自动化。"
      actions={
        <Select
          label="按 Agent 筛选"
          value={agent}
          options={['全部 Agent', ...new Set(runs.map((run) => run.agent))]}
          onChange={setAgent}
        />
      }
    >
      {shown.length ? (
        <div className="list-card">
          {shown.map((run) => (
            <button key={run.id} className="list-row" onClick={() => openRun(run.id)}>
              <span className="grow">
                <strong>{run.title}</strong>
                <span className="muted small">
                  {run.agent} · 来自{run.source}
                </span>
              </span>
              <StatusBadge status={run.state} />
              <span className="muted small">{run.time}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty title={done ? '还没有结束的运行' : '现在没有运行中的工作'} />
      )}
    </PageFrame>
  );
}

// ─── Notifications ───

function NotificationsPage() {
  const { selection, openRun, openRecord, records, notify } = useDesign();
  const [read, setRead] = useState<string[]>([]);
  if (selection === '需要你')
    return (
      <PageFrame title="需要你" help="等你决定的事。在这里直接处理，或回到来源对话。">
        <div className="stack">
          <button className="list-row bordered" onClick={() => openRun('run-1')}>
            <StatusBadge status="需要你" />
            <span className="grow">
              <strong>把 2 条任务标为已完成？</strong>
              <span className="muted small">卷卷 · 4 分钟后过期</span>
            </span>
            <ChevronRight size={15} />
          </button>
          <RequestCard kind="takeover" onDone={() => notify('已交还给 Greeny')} />
        </div>
      </PageFrame>
    );
  const items = [
    { id: 'n1', title: '周报已生成', description: '葵葵 · 定时', time: '10:30', open: () => openRun('run-3') },
    {
      id: 'n2',
      title: '你被指派了一条任务',
      description: '确认移动端导航',
      time: '20 分钟前',
      open: () => openRecord(records[6]),
    },
    { id: 'n3', title: '同步供应商报价失败', description: '登录已过期', time: '09:00', open: () => openRun('run-4') },
  ];
  return (
    <PageFrame
      title="全部通知"
      actions={
        <Button
          kind="ghost"
          onClick={() => {
            setRead(items.map((item) => item.id));
            notify('已全部标为已读');
          }}
        >
          <CheckCheck size={16} />
          全部已读
        </Button>
      }
    >
      <div className="list-card">
        {items.map((item) => (
          <button
            className="list-row"
            key={item.id}
            onClick={() => {
              setRead((value) => [...new Set([...value, item.id])]);
              item.open();
            }}
          >
            <span className={`read-dot ${read.includes(item.id) ? 'read' : ''}`} />
            <span className="grow">
              <strong>{item.title}</strong>
              <span className="muted small">{item.description}</span>
            </span>
            <span className="muted small">{item.time}</span>
          </button>
        ))}
      </div>
    </PageFrame>
  );
}

// ─── Settings ───

function SettingsBlock({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="row">
        <h2>{title}</h2>
        {help && <HelpHint label={title}>{help}</HelpHint>}
      </div>
      {children}
    </section>
  );
}
function Saving({ dirty, onSave, onReset }: { dirty: boolean; onSave: () => void; onReset: () => void }) {
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <div className="save-bar">
      <span className="muted small">{busy ? '保存中…' : dirty ? '有未保存的更改' : ''}</span>
      <Button disabled={!dirty || busy} onClick={onReset}>
        取消
      </Button>
      <Button
        kind="primary"
        disabled={!dirty}
        loading={busy}
        onClick={() => {
          setBusy(true);
          timer.current = setTimeout(() => {
            setBusy(false);
            onSave();
          }, 600);
        }}
      >
        保存
      </Button>
    </div>
  );
}
function Toggle({
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="setting-row">
      <div className="row">
        <strong>{label}</strong>
        {help && <HelpHint label={label}>{help}</HelpHint>}
      </div>
      <Switch label={label} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function SettingsPage() {
  const { selection, theme, setTheme, notify, openProvider, openPanel } = useDesign();
  const [name, setName] = useState('林杰');
  const [about, setAbout] = useState('回答时先给结论，再给必要的依据。');
  const [saved, setSaved] = useState({ name: '林杰', about: '回答时先给结论，再给必要的依据。' });
  const [error, setError] = useState('');
  const [channels, setChannels] = useState({ 邮件: true, 飞书: true, 手机推送: true, 预览: false });
  if (selection === '通知')
    return (
      <PageFrame title="通知" width="form">
        <SettingsBlock
          title="送达渠道"
          help="站内通知总是开启。其他渠道只送达「需要你」和「完成」两类，内容默认不带预览。"
        >
          <Toggle label="站内" checked onChange={() => {}} disabled help="站内通知不能关闭。" />
          {(['邮件', '飞书', '手机推送'] as const).map((key) => (
            <Toggle
              key={key}
              label={key}
              checked={channels[key]}
              onChange={(value) => {
                setChannels((current) => ({ ...current, [key]: value }));
                notify('已保存');
              }}
            />
          ))}
          <div className="setting-row">
            <div className="row">
              <strong>企业微信</strong>
            </div>
            <Button kind="ghost" onClick={() => notify('先在「连接」里绑定企业微信')}>
              去连接
            </Button>
          </div>
        </SettingsBlock>
        <SettingsBlock title="隐私">
          <Toggle
            label="推送显示内容预览"
            help="关闭时，锁屏和通知栏只显示「你有一条新消息」。"
            checked={channels.预览}
            onChange={(value) => {
              setChannels((current) => ({ ...current, 预览: value }));
              notify('已保存');
            }}
          />
        </SettingsBlock>
      </PageFrame>
    );
  if (selection === '连接')
    return (
      <PageFrame
        title="连接"
        width="form"
        help="让你的 Agent 使用你自己的账号：工具（由管理员安装）、飞书 / 企业微信账号、工作邮箱。断开后，Agent 立即失去访问。"
      >
        <div className="list-card">
          {connections.map((item) => (
            <div className="list-row" key={item.id}>
              <span className="file-icon">
                <Link2 size={18} />
              </span>
              <span className="grow">
                <strong>{item.name}</strong>
                <span className="muted small">
                  {item.kind} · {item.detail}
                </span>
              </span>
              <StatusBadge status={item.state} />
              <Button
                onClick={() =>
                  openPanel(
                    item.name,
                    <div className="stack">
                      <p>
                        {item.state === '已连接'
                          ? '断开后，Agent 立即失去访问；正在运行的工作会停下来问你。'
                          : '用你自己的账号授权，Agent 只能做你本人能做的事。'}
                      </p>
                      <OverlayActions>
                        <Button
                          kind={item.state === '已连接' ? 'danger' : 'primary'}
                          onClick={() => notify(item.state === '已连接' ? '已断开' : '已连接（示例）')}
                        >
                          {item.state === '已连接' ? '断开' : item.state === '已过期' ? '重新连接' : '连接'}
                        </Button>
                      </OverlayActions>
                    </div>,
                  )
                }
              >
                {item.state === '已连接' ? '管理' : item.state === '已过期' ? '重新连接' : '连接'}
              </Button>
            </div>
          ))}
        </div>
      </PageFrame>
    );
  if (selection === '密码库')
    return (
      <PageFrame
        title="密码库"
        width="form"
        help="Agent 在电脑里登录网站时使用这些登录信息，但永远看不到明文。每条可以限定给哪些 Agent 用。"
        actions={
          <Button kind="primary" onClick={() => notify('添加登录：网站、用户名、密码（只写）')}>
            <Plus size={15} />
            添加登录
          </Button>
        }
      >
        <div className="list-card">
          {[
            ['supplier.example.com', 'linjie', '卷卷、Greeny', '询问'],
            ['github.com', 'linjie', 'Greeny', '自动'],
          ].map(([site, user, who, mode]) => (
            <div className="list-row" key={site}>
              <KeyRound size={18} />
              <span className="grow">
                <strong>{site}</strong>
                <span className="muted small">
                  {user} · {who} 可用
                </span>
              </span>
              <Badge>{mode}</Badge>
              <Menu
                items={[
                  { label: '替换密码', onClick: () => notify('只写：输入新密码') },
                  { label: '删除', danger: true, onClick: () => notify('已删除') },
                ]}
              />
            </div>
          ))}
        </div>
      </PageFrame>
    );
  if (selection === '我的服务')
    return (
      <PageFrame
        title="我的服务"
        width="form"
        help="管理员允许的能力，可以换成你自己的 Key。只有你的调用会用它，用量记在你名下。"
      >
        <div className="list-card">
          {capabilities
            .filter((item) => item.personal)
            .map((item) => (
              <div className="list-row" key={item.id}>
                <span className="file-icon">
                  <Server size={18} />
                </span>
                <span className="grow">
                  <strong>{item.label}</strong>
                  <span className="muted small">工作区 · {workspaceProviders[item.id][0]?.name ?? '浏览器自带'}</span>
                </span>
                <Button onClick={() => openProvider(item.id, true)}>使用我的 Key</Button>
              </div>
            ))}
        </div>
      </PageFrame>
    );
  if (selection === '外部访问')
    return (
      <PageFrame
        title="外部访问"
        width="form"
        help="你授权过的外部 Agent 和客户端（例如 Claude、Cursor）通过 MCP 访问 Greenhouse，权限不超过你本人。"
      >
        <SettingsBlock title="已授权">
          {[
            ['Claude Desktop', '读取知识库、表格 · 10 月 3 日授权'],
            ['Cursor', '读取知识库 · 9 月 21 日授权'],
          ].map(([client, scope]) => (
            <div className="setting-row" key={client}>
              <div>
                <strong>{client}</strong>
                <p className="muted small">{scope}</p>
              </div>
              <Button kind="danger" onClick={() => notify(`已撤销 ${client}`)}>
                撤销
              </Button>
            </div>
          ))}
        </SettingsBlock>
        <SettingsBlock title="个人访问令牌" help="给命令行工具用。令牌只在创建时显示一次。">
          <Button onClick={() => notify('令牌只显示一次，请立即复制')}>
            <Plus size={15} />
            创建令牌
          </Button>
        </SettingsBlock>
      </PageFrame>
    );
  const dirty = name !== saved.name || about !== saved.about;
  return (
    <PageFrame title="账号" width="form">
      <SettingsBlock title="资料">
        <div className="row">
          <span className="member-avatar large">林</span>
          <Button kind="ghost">更换头像</Button>
        </div>
        <Field label="名字" error={error} required>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
          />
        </Field>
        <Field label="邮箱">
          <Input value="super@greenhouse.local" readOnly />
        </Field>
        <Field label="关于我" help="所有 Agent 都会读到这段话：你的身份、偏好与习惯。比「记忆」更稳定，由你自己维护。">
          <TextArea rows={3} value={about} onChange={(event) => setAbout(event.target.value)} />
        </Field>
        <Saving
          dirty={dirty}
          onReset={() => {
            setName(saved.name);
            setAbout(saved.about);
          }}
          onSave={() => {
            if (!name.trim()) {
              setError('请输入名字');
              return;
            }
            setSaved({ name, about });
            notify('已保存');
          }}
        />
      </SettingsBlock>
      <SettingsBlock title="偏好" help="偏好改了就保存。">
        <div className="setting-row">
          <strong>主题</strong>
          <Segmented
            label="主题"
            items={['浅色', '深色', '跟随系统']}
            value={theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}
            onChange={(value) => setTheme(value === '浅色' ? 'light' : value === '深色' ? 'dark' : 'system')}
          />
        </div>
        <div className="setting-row">
          <strong>语言</strong>
          <Select label="语言" value="简体中文" options={['简体中文', 'English']} onChange={() => notify('已保存')} />
        </div>
      </SettingsBlock>
      <SettingsBlock title="安全">
        <div className="setting-row">
          <strong>密码</strong>
          <Button onClick={() => notify('重置链接已发到你的邮箱')}>修改密码</Button>
        </div>
      </SettingsBlock>
    </PageFrame>
  );
}

// ─── Admin ───

function AdminPage() {
  const { selection, notify, openPanel, openProvider, newItem, confirm } = useDesign();
  const [tab, setTab] = useState('成员');
  const [paused, setPaused] = useState(false);
  const [accent, setAccent] = useState('#235D4D');
  if (selection === '服务')
    return (
      <PageFrame
        title="服务"
        width="form"
        help="每种能力都可以换成任意服务商。部署时可以用环境变量初始化，之后在这里修改，立即生效。"
      >
        <div className="list-card">
          {capabilities.map((item) => {
            const list = workspaceProviders[item.id];
            const status = !list.length
              ? '未配置'
              : list.some((instance) => instance.status === '不可用')
                ? '部分不可用'
                : '可用';
            return (
              <div className="list-row" key={item.id}>
                <span className="file-icon">
                  <Server size={18} />
                </span>
                <span className="grow">
                  <span className="row tight">
                    <strong>{item.label}</strong>
                    <HelpHint label={item.label}>{item.hint}</HelpHint>
                  </span>
                  <span className="muted small">
                    {list.length ? list.map((instance) => instance.name).join(' → ') : '没有配置'}
                    {list.some((instance) => instance.source === '环境变量') && ' · 来自环境变量'}
                  </span>
                </span>
                <StatusBadge status={status} />
                <Button onClick={() => openProvider(item.id)}>配置</Button>
              </div>
            );
          })}
          <div className="list-row">
            <span className="file-icon">
              <Server size={18} />
            </span>
            <span className="grow">
              <strong>渠道</strong>
              <span className="muted small">系统发信 SMTP · 飞书 · 企业微信 · 手机推送</span>
            </span>
            <StatusBadge status="可用" />
            <Button
              onClick={() => openPanel('渠道', <p>系统发信、飞书、企业微信与手机推送的配置，形式与服务相同。</p>)}
            >
              配置
            </Button>
          </div>
        </div>
      </PageFrame>
    );
  if (selection === '用量')
    return (
      <PageFrame title="用量" help="按成员、Agent 和服务统计。只计数，不包含任何内容。">
        <Segmented label="维度" items={['成员', 'Agent', '服务']} value="成员" onChange={() => {}} />
        <MiniChart title="本月 token（百万）" />
        <div className="list-card">
          {members.map((member) => (
            <div className="list-row" key={member.email}>
              <span className="member-avatar">{member.name[0]}</span>
              <span className="grow">
                <strong>{member.name}</strong>
                <span className="muted small">上限 {member.budget}</span>
              </span>
              <span className="tabular">1.2M</span>
            </div>
          ))}
        </div>
      </PageFrame>
    );
  if (selection === '连接器')
    return (
      <PageFrame
        title="连接器"
        width="form"
        help="安装后，成员在「设置 → 连接」里用自己的账号连接。Agent 通过它们使用外部工具，写操作需要确认。"
        actions={
          <Button kind="primary" onClick={() => openPanel('安装连接器', <p>从官方目录、MCP Registry 或 URL 安装。</p>)}>
            <Plus size={15} />
            安装连接器
          </Button>
        }
      >
        <div className="list-card">
          {[
            ['GitHub', '每人自己授权（OAuth）', '12 人已连接'],
            ['Notion', '每人自己授权（OAuth）', '3 人已连接'],
            ['高德地图', '共用一个 Key', '全员可用'],
          ].map(([name, auth, usage]) => (
            <div className="list-row" key={name}>
              <span className="file-icon">
                <Link2 size={18} />
              </span>
              <span className="grow">
                <strong>{name}</strong>
                <span className="muted small">
                  {auth} · {usage}
                </span>
              </span>
              <Menu
                items={[
                  { label: '工具与权限', onClick: () => {} },
                  { label: '卸载', danger: true, onClick: () => notify('已卸载') },
                ]}
              />
            </div>
          ))}
        </div>
      </PageFrame>
    );
  if (selection === '外部访问')
    return (
      <PageFrame
        title="外部访问"
        width="form"
        help="通过 MCP 接入 Greenhouse 的客户端。交互客户端代表某位成员；机器客户端用于脚本与集成，权限按范围授予。"
      >
        <div className="list-card">
          {[
            ['Claude Desktop', '交互 · 8 位成员已授权'],
            ['内部数据同步', '机器 · 只读表格'],
          ].map(([name, detail]) => (
            <div className="list-row" key={name}>
              <span className="grow">
                <strong>{name}</strong>
                <span className="muted small">{detail}</span>
              </span>
              <Menu
                items={[
                  { label: '轮换密钥', onClick: () => notify('新密钥只显示一次') },
                  { label: '停用', danger: true, onClick: () => notify('已停用') },
                ]}
              />
            </div>
          ))}
        </div>
      </PageFrame>
    );
  if (selection === '公开 Agents')
    return (
      <PageFrame title="公开 Agents" width="form" help="成员发布给同事的 Agent。管理员只能暂停或恢复，看不到对话内容。">
        <div className="list-card">
          <div className="list-row">
            <PlantAvatar plant="dandelion" size={28} animate={false} />
            <span className="grow">
              <strong>蒲蒲 · 研究员</strong>
              <span className="muted small">陈晨发布 · 本月 128 次回复 · 92% 有帮助</span>
            </span>
            <StatusBadge status={paused ? '已暂停' : '已发布'} />
            <Switch label="暂停蒲蒲" checked={!paused} onChange={(value) => setPaused(!value)} />
          </div>
        </div>
      </PageFrame>
    );
  if (selection === '品牌')
    return (
      <PageFrame
        title="品牌"
        width="form"
        help="只能修改名称、Logo 和主色。主色会自动推导出悬停、选中和焦点颜色，并保证对比度。"
      >
        <SettingsBlock title="外观">
          <Field label="名称">
            <Input defaultValue="Greenhouse" />
          </Field>
          <Field label="Logo">
            <Button>上传</Button>
          </Field>
          <Field label="主色">
            <div className="row">
              {['#235D4D', '#2A64AD', '#7A45AE', '#AD4600'].map((color) => (
                <button
                  key={color}
                  className="swatch"
                  aria-label={`主色 ${color}`}
                  aria-pressed={accent === color}
                  style={{ background: color }}
                  onClick={() => setAccent(color)}
                />
              ))}
            </div>
          </Field>
          <div className="brand-preview" style={{ ['--gh-accent' as string]: accent }}>
            <Button kind="primary">主按钮</Button>
            <span className="muted small">预览</span>
          </div>
          <div className="save-bar">
            <Button kind="primary" onClick={() => notify('品牌已保存，登录页同时生效')}>
              保存
            </Button>
          </div>
        </SettingsBlock>
      </PageFrame>
    );
  return (
    <PageFrame
      title="成员与分组"
      actions={
        <Button kind="primary" onClick={newItem}>
          <Plus size={15} />
          邀请成员
        </Button>
      }
    >
      <Tabs items={['成员', '分组']} value={tab} onChange={setTab} label="成员与分组" />
      {tab === '分组' ? (
        <div className="list-card">
          {['产品组 · 4 人', '研发组 · 9 人'].map((group) => (
            <div className="list-row" key={group}>
              <span className="grow">{group}</span>
              <Menu items={[{ label: '编辑成员', onClick: () => {} }]} />
            </div>
          ))}
        </div>
      ) : (
        <div className="list-card">
          {members.map((member, index) => (
            <div key={member.email} className="list-row">
              <span className="member-avatar">{member.name[0]}</span>
              <span className="grow">
                <strong>
                  {member.name}
                  {index === 0 && <span className="muted small">（你）</span>}
                </strong>
                <span className="muted small">
                  {member.email} · {member.budget}
                </span>
              </span>
              <Select
                label={`${member.name} 角色`}
                disabled={index === 0}
                value={member.role}
                options={['成员', '管理员']}
                onChange={(role) =>
                  confirm({
                    title: `把${member.name}设为${role}？`,
                    body:
                      role === '管理员'
                        ? '管理员可以管理成员、服务、预算和连接器，但看不到成员的对话。'
                        : '对方会失去管理权限。',
                    confirmLabel: `设为${role}`,
                    onConfirm: () => notify('角色已更新'),
                  })
                }
              />
              <Menu
                items={[
                  { label: '模块权限与预算', onClick: () => {} },
                  { label: '发送重置链接', onClick: () => {} },
                  { label: '停用', danger: true, onClick: () => {} },
                ]}
              />
            </div>
          ))}
        </div>
      )}
    </PageFrame>
  );
}
