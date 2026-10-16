import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BellOff, Check, ChevronRight, Copy, Hash, Lock, Pencil, Pin, Plus, Trash2, Upload } from 'lucide-react';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import { categorical, color, radius, space, type as typeScale } from '@greenhouse/ui/tokens';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DatePicker,
  DateRangePicker,
  Empty,
  ErrorBox,
  Field,
  HelpHint,
  IconButton,
  Input,
  KitProvider,
  Menu,
  Popover,
  MultiSelect,
  Radio,
  SearchInput,
  SecretField,
  Segmented,
  Select,
  Skeleton,
  Spinner,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
  useContextMenu,
} from '@greenhouse/ui/kit';
import { ApprovalCard, MiniChart, PageFrame, RequestCard } from './components';
import { useDesign } from './context';
import {
  ChatPage,
  ArtifactCard,
  Attachment,
  CodeBlock,
  MediaResults,
  MessageBubble,
  RecordsCard,
  RichTable,
  RunCard,
  ToolCard,
} from './chat';
import { TablePage } from './pages';
import { labSections } from './shell';

function Section({
  id,
  title,
  rule,
  children,
}: {
  id: number;
  title: string;
  /** The section's one rule, in one sentence. */
  rule: string;
  children: ReactNode;
}) {
  return (
    <section className="lab-section" id={`lab-${id}`}>
      <header className="lab-section-title">
        <span>{String(id + 1).padStart(2, '0')}</span>
        <div>
          <h2>{title}</h2>
          <p className="muted">{rule}</p>
        </div>
      </header>
      {children}
    </section>
  );
}
function Sample({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`sample ${wide ? 'wide-sample' : ''}`}>
      <span className="sample-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export function ComponentLab() {
  const { records, openRecord, openPanel, confirm, notify, theme, setTheme, density, setDensity } = useDesign();
  const [checked, setChecked] = useState(false);
  const [switchOn, setSwitchOn] = useState(true);
  const [selected, setSelected] = useState('表格');
  const [scope, setScope] = useState('团队');
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [enDue, setEnDue] = useState('2026-10-16');
  const [radio, setRadio] = useState('团队');
  const [status, setStatus] = useState('进行中');
  const [owner, setOwner] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [members, setMembers] = useState(['陈晨', '周宁']);
  const [due, setDue] = useState('2026-10-16');
  const [range, setRange] = useState(['2026-10-12', '2026-10-16']);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const mode = document.querySelector('.product-window')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  return (
    <PageFrame
      title="组件与状态"
      help="页面和这里用的是同一份组件。点击、输入，体验每一种状态。规范见 docs/design-system。"
      actions={
        <>
          <Select
            size="sm"
            label="组件主题"
            value={theme === 'dark' ? '深色' : theme === 'system' ? '跟随系统' : '浅色'}
            options={['浅色', '深色', '跟随系统']}
            onChange={(value) => setTheme(value === '浅色' ? 'light' : value === '深色' ? 'dark' : 'system')}
          />
          <Select
            size="sm"
            label="组件密度"
            value={density}
            options={['舒适', '紧凑']}
            onChange={(value) => setDensity(value as '舒适' | '紧凑')}
          />
        </>
      }
      className="component-lab"
    >
      <nav className="lab-index" aria-label="组件分区">
        {labSections.map((title, index) => (
          <a
            key={title}
            href={`#components/lab-${index}`}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(`lab-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >
            {title}
          </a>
        ))}
      </nav>
      <Section id={0} title="基础" rule="颜色按角色取用；这里的值直接读自 packages/ui/src/tokens/haven.ts。">
        <div className="token-grid">
          {Object.entries(color)
            .filter(([name]) => !name.endsWith('Fill') && name !== 'scrim')
            .map(([name, value]) => (
              <div className="token" key={name}>
                <span className="token-swatch" style={{ background: `var(--gh-${kebab(name)})` }} />
                <span className="small">{name}</span>
                <span className="muted small tabular">{value[mode]}</span>
              </div>
            ))}
        </div>
        <div className="row wrap">
          {Object.entries(categorical).map(([name, pair]) => (
            <span
              key={name}
              className="tag"
              style={{ color: `var(--gh-cat-${name})`, background: `var(--gh-cat-${name}-fill)` }}
              title={`${pair.fg[mode]} / ${pair.fill[mode]}`}
            >
              {name}
            </span>
          ))}
        </div>
        <div className="type-scale">
          {Object.entries(typeScale).map(([name, style]) => (
            <div key={name} className="row">
              <span className="muted small type-name">
                {name} · {style.size}/{style.line}/{style.weight}
              </span>
              <span style={{ font: `var(--gh-type-${kebab(name)})` }}>安静的界面，清晰的工作</span>
            </div>
          ))}
        </div>
        <p className="muted small">
          间距 {Object.values(space).join(' · ')} px · 圆角{' '}
          {Object.entries(radius)
            .filter(([key]) => key !== 'full')
            .map(([, value]) => value)
            .join(' · ')}{' '}
          px
        </p>
      </Section>
      <Section id={1} title="导航与身份" rule="选中只强调当前位置；图标不代替必要的名称。">
        <div className="sample-grid">
          <Sample label="品牌">
            <div className="brand-sample">
              <GreenhouseMark />
              <strong>Greenhouse</strong>
            </div>
          </Sample>
          <Sample label="Agent 头像">
            <div className="row">
              <PlantAvatar plant="sprout" size={40} animate={false} />
              <PlantAvatar plant="fern" size={40} animate={false} />
              <PlantAvatar plant="sunflower" size={40} animate={false} />
              <PlantAvatar plant="dandelion" size={40} animate={false} />
            </div>
          </Sample>
          <Sample label="思考 / 说话 / 需要你 / 失败">
            <div className="row">
              <PlantAvatar plant="sprout" size={36} state="thinking" />
              <PlantAvatar plant="sprout" size={36} state="speaking" />
              <PlantAvatar plant="sprout" size={36} state="waiting" />
              <PlantAvatar plant="sprout" size={36} state="error" />
            </div>
          </Sample>
          <Sample label="Tabs（同一对象的视图）" wide>
            <Tabs items={['表格', '看板', '时间线']} value={selected} onChange={setSelected} />
          </Sample>
          <Sample label="分段（2–4 个互斥范围）">
            <Segmented label="范围" items={['团队', '个人', '分享给我']} value={scope} onChange={setScope} />
          </Sample>
          <Sample label="对话目录：主 Agent 在最上方，没有标题">
            <div className="demo-sidebar">
              <Button kind="primary" className="sidebar-create" onClick={() => notify('主操作')}>
                <Plus size={16} />
                新会话
              </Button>
              <button className="sidebar-item main selected">
                <PlantAvatar plant="sprout" size={36} animate={false} />
                <span className="sidebar-item-title">Greeny</span>
              </button>
              <button className="sidebar-item">
                <PlantAvatar plant="sunflower" size={20} animate={false} />
                <span className="sidebar-item-title">葵葵</span>
                <span className="running-dot" aria-label="运行中" />
              </button>
              <button className="sidebar-item">
                <PlantAvatar plant="fern" size={20} animate={false} />
                <span className="sidebar-item-title">卷卷</span>
                <span className="count warning">1</span>
              </button>
              <button className="sidebar-item">
                <PlantAvatar plant="dandelion" size={20} animate={false} />
                <span className="sidebar-item-title">蒲蒲</span>
                <BellOff size={13} className="row-muted" aria-label="已静音" />
              </button>
              <button className="sidebar-item" disabled>
                <Hash size={15} />
                <span className="sidebar-item-title">已归档 · 暂不可用</span>
              </button>
            </div>
          </Sample>
          <Sample label="右键菜单（也可 Shift F10、长按）">
            <ContextMenuDemo />
          </Sample>
          <Sample label="更多菜单">
            <Menu
              items={[
                { label: '打开', icon: <ChevronRight size={15} />, onClick: () => openRecord(records[0]) },
                { label: '复制', icon: <Copy size={15} />, onClick: () => notify('已复制') },
                { label: '没有权限', icon: <Pencil size={15} />, disabled: true, onClick: () => {} },
                '-',
                { label: '删除', icon: <Trash2 size={15} />, danger: true, onClick: () => notify('删除前会确认') },
              ]}
            />
          </Sample>
        </div>
      </Section>
      <Section id={2} title="按钮与操作" rule="每个区域只有一个主操作；等待时不能重复提交。">
        <div className="sample-grid">
          <Sample label="主要">
            <Button kind="primary" onClick={() => notify('主要操作')}>
              保存
            </Button>
          </Sample>
          <Sample label="次要">
            <Button onClick={() => notify('次要操作')}>取消</Button>
          </Sample>
          <Sample label="轻操作">
            <Button kind="ghost" onClick={() => notify('已打开')}>
              查看详情 <ChevronRight size={14} />
            </Button>
          </Sample>
          <Sample label="危险">
            <Button
              kind="danger"
              onClick={() =>
                confirm({
                  title: '删除「完善成员邀请流程」？',
                  body: '记录会进入回收站，30 天内可以恢复。',
                  confirmLabel: '删除记录',
                  danger: true,
                  onConfirm: () => notify('已删除'),
                })
              }
            >
              <Trash2 size={15} />
              删除
            </Button>
          </Sample>
          <Sample label="悬停">
            <Button kind="primary" className="state-hover">
              保存
            </Button>
          </Sample>
          <Sample label="焦点">
            <Button className="state-focus">继续</Button>
          </Sample>
          <Sample label="禁用（旁边的「?」或悬停说明原因）">
            <span className="row wrap">
              <Button disabled>发布</Button>
              <HelpHint label="发布">只有表格的拥有者可以发布应用。</HelpHint>
              <Button disabled disabledReason="只有表格的拥有者可以导出。">
                导出
              </Button>
            </span>
          </Sample>
          <Sample label="等待">
            <Button
              kind="primary"
              loading={loading}
              onClick={() => {
                setLoading(true);
                timer.current = setTimeout(() => {
                  setLoading(false);
                  notify('已保存');
                }, 1100);
              }}
            >
              {loading ? '保存中' : '点我保存'}
            </Button>
          </Sample>
          <Sample label="图标按钮（悬停 500ms 或键盘聚焦出现标签）">
            <div className="row">
              <IconButton label="添加" onClick={() => notify('已添加')}>
                <Plus size={18} />
              </IconButton>
              <IconButton label="已选中" aria-pressed onClick={() => notify('切换')}>
                <Check size={18} />
              </IconButton>
              <IconButton label="上传" disabled disabledReason="只有拥有者可以上传">
                <Upload size={18} />
              </IconButton>
              <IconButton label="小号" size="sm" onClick={() => notify('小号图标按钮')}>
                <Pencil size={14} />
              </IconButton>
            </div>
          </Sample>
        </div>
      </Section>
      <Section id={3} title="表单与说明" rule="标签始终可见；错误贴着字段；补充说明收进「?」。">
        <div className="sample-grid">
          <Sample label="「?」说明">
            <Field label="职责" help="一句话说明它负责什么。会显示在对话目录里，也会写进它的指令。">
              <Input value={input} placeholder="例如：采购助手" onChange={(event) => setInput(event.target.value)} />
            </Field>
          </Sample>
          <Sample label="必填 + 错误">
            <Field label="邮箱" error="请输入有效的邮箱" required>
              <Input aria-invalid defaultValue="chen@" />
            </Field>
          </Sample>
          <Sample label="只读">
            <Field label="编号">
              <Input value="GH-104" readOnly />
            </Field>
          </Sample>
          <Sample label="禁用">
            <Field label="工作区">
              <Input value="Greenhouse" disabled />
            </Field>
          </Sample>
          <Sample label="机密（只写不读）">
            <SecretField
              label="API Key"
              configured
              onSave={() => notify('Key 已保存')}
              help="保存后只显示「已配置」，任何接口都不返回明文。"
            />
          </Sample>
          <Sample label="搜索">
            <SearchInput label="组件搜索" value={input} onChange={setInput} placeholder="搜索…" />
          </Sample>
          <Sample label="多行文本（随内容增高）">
            <Field label="说明" description="最多 12 行，之后在框内滚动。">
              <TextArea
                rows={2}
                value={note}
                placeholder="写点什么"
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </Sample>
          <Sample label="下拉">
            <Field label="状态">
              <Select label="示例状态" value={status} options={['待处理', '进行中', '已完成']} onChange={setStatus} />
            </Field>
          </Sample>
          <Sample label="下拉 · 未选">
            <Field label="负责人">
              <Select
                label="示例负责人"
                value={owner}
                placeholder="选择成员"
                options={['林杰', '陈晨', '周宁']}
                onChange={setOwner}
              />
            </Field>
          </Sample>
          <Sample label="下拉 · 搜索与说明">
            <Field label="默认模型">
              <Select
                label="示例模型"
                value={model}
                onChange={setModel}
                options={[
                  { value: 'deepseek-chat', label: 'DeepSeek V3', description: '公司 DeepSeek · 默认' },
                  { value: 'deepseek-reasoner', label: 'DeepSeek R1', description: '公司 DeepSeek · 推理' },
                  { value: 'claude-sonnet', label: 'Claude Sonnet', description: 'Claude · 强' },
                  { value: 'claude-haiku', label: 'Claude Haiku', description: 'Claude · 快' },
                  { value: 'kimi', label: 'Kimi K2', description: 'Kimi' },
                  { value: 'qwen', label: '通义千问 Max', description: '通义千问' },
                  { value: 'glm', label: 'GLM 4.6', description: '智谱 GLM' },
                  { value: 'doubao', label: '豆包 Pro', description: '豆包' },
                  { value: 'gpt', label: 'GPT 5', description: 'OpenAI · 未配置', disabled: true },
                ]}
              />
            </Field>
          </Sample>
          <Sample label="下拉 · 禁用 / 错误">
            <div className="stack">
              <Select label="禁用的下拉" value="管理员" options={['管理员', '成员']} onChange={() => {}} disabled />
              <Field label="分组" error="请选择分组">
                <Select
                  label="示例分组"
                  value=""
                  placeholder="选择分组"
                  options={['产品组', '设计组']}
                  onChange={() => {}}
                />
              </Field>
            </div>
          </Sample>
          <Sample label="多选">
            <Field label="成员">
              <MultiSelect
                label="示例成员"
                value={members}
                options={['林杰', '陈晨', '周宁', '王芳', '李雷']}
                onChange={setMembers}
              />
            </Field>
          </Sample>
          <Sample label="复选（半选 / 禁用）">
            <div className="stack tight">
              <Checkbox label="同步到团队" checked={checked} onChange={setChecked} />
              <Checkbox label="部分选择" checked={false} indeterminate onChange={() => notify('全选')} />
              <Checkbox label="已归档 · 不可改" checked disabled onChange={() => {}} />
            </div>
          </Sample>
          <Sample label="开关（立即生效）">
            <div className="row">
              <span>通知</span>
              <Switch label="组件通知" checked={switchOn} onChange={setSwitchOn} />
              <Switch label="禁用开关" checked={false} onChange={() => {}} disabled />
            </div>
          </Sample>
          <Sample label="单选">
            <div className="stack tight">
              {['团队', '个人'].map((item) => (
                <Radio
                  key={item}
                  name="lab-scope"
                  value={item}
                  label={item}
                  checked={radio === item}
                  onChange={() => setRadio(item)}
                />
              ))}
            </div>
          </Sample>
          <Sample label="日期">
            <Field label="截止日期">
              <DatePicker label="示例截止日期" value={due} onChange={setDue} />
            </Field>
          </Sample>
          <Sample label="日期 · 范围">
            <Field label="起止日期">
              <DateRangePicker
                label="示例起止日期"
                start={range[0]}
                end={range[1]}
                onChange={(start, end) => setRange([start, end])}
              />
            </Field>
          </Sample>
          <Sample label="日期 · 限定范围 / 禁用">
            <div className="stack">
              <DatePicker label="只能选本周之后" value="" min="2026-10-19" onChange={() => {}} placeholder="下周起" />
              <DatePicker label="禁用的日期" value="2026-10-16" onChange={() => {}} disabled />
            </div>
          </Sample>
          <Sample label="英文（KitProvider locale=en）">
            <KitProvider locale="en">
              <Field label="Due date">
                <DatePicker label="Due date" value={enDue} onChange={setEnDue} />
              </Field>
            </KitProvider>
          </Sample>
        </div>
      </Section>
      <Section id={4} title="数据" rule="桌面按列对齐；手机先显示名称和关键状态。">
        <div className="sample-grid">
          <Sample label="记录引用" wide>
            <RecordsCard records={records.slice(0, 2)} />
          </Sample>
          <Sample label="状态词">
            <div className="row wrap">
              <StatusBadge status="排队中" />
              <StatusBadge status="运行中" />
              <StatusBadge status="需要你" />
              <StatusBadge status="已完成" />
              <StatusBadge status="失败" />
              <StatusBadge status="已取消" />
              <Badge>只读</Badge>
            </div>
          </Sample>
          <Sample label="图表">
            <MiniChart />
          </Sample>
          <Sample label="浮层面板（筛选）">
            <Popover label="筛选" trigger="筛选" wide>
              <div className="row wrap">
                <Select label="字段" value="状态" options={['状态', '负责人', '截止日期']} onChange={() => {}} />
                <Select label="条件" value="是" options={['是', '不是', '为空']} onChange={() => {}} />
                <Select label="值" value={status} options={['待处理', '进行中', '已完成']} onChange={setStatus} />
              </div>
            </Popover>
          </Sample>
        </div>
        <div className="lab-table">
          <TablePage embedded />
        </div>
      </Section>
      <Section id={5} title="反馈与边界" rule="空、等待、失败、无权限各说各话，都给下一步。">
        <div className="sample-grid">
          <Sample label="首次为空" wide>
            <Empty title="还没有表格" action={<Button onClick={() => notify('新建表格')}>新建表格</Button>} />
          </Sample>
          <Sample label="无结果" wide>
            <Empty title="没有匹配的记录" action={<Button>清除筛选</Button>} />
          </Sample>
          <Sample label="骨架">
            <Skeleton lines={4} />
          </Sample>
          <Sample label="进行中（转圈只在按钮里和行内）">
            <div className="row">
              <Spinner />
              <span>保存中…</span>
            </div>
          </Sample>
          <Sample label="失败" wide>
            <ErrorBox onRetry={() => notify('已重试')}>保存失败，你的输入已保留。</ErrorBox>
          </Sample>
          <Sample label="横幅（一屏一条，能做点什么时才出现）" wide>
            <Banner action={<Button size="sm">去添加</Button>}>
              还没有可用的模型服务：先添加一个，Agent 才能回答。
            </Banner>
          </Sample>
          <Sample label="可关的横幅" wide>
            <Banner tone="warning" onClose={() => notify('已关闭')}>
              本月预算已用 90%。
            </Banner>
          </Sample>
          <Sample label="无权限" wide>
            <Empty icon={<Lock />} title="你没有访问权限" description="向表格拥有者陈晨申请。" />
          </Sample>
          <Sample label="成功提示">
            <Button onClick={() => notify('已保存')}>显示提示</Button>
          </Sample>
          <Sample label="可撤销">
            <Button onClick={() => notify('已归档', { label: '撤销', onClick: () => notify('已恢复') })}>
              归档并撤销
            </Button>
          </Sample>
        </div>
      </Section>
      <Section id={6} title="详情与确认" rule="桌面右侧抽屉、手机底部弹框；编辑在同一个面板里进行。">
        <div className="sample-grid">
          <Sample label="记录：查看 → 编辑 → 保存">
            <Button onClick={() => openRecord(records[0])}>打开记录</Button>
          </Sample>
          <Sample label="具体的确认（最终确认用实红底）">
            <Button
              onClick={() =>
                confirm({
                  title: '取消「整理客户访谈」？',
                  body: '运行会停止，已完成的步骤和产物会保留。',
                  confirmLabel: '取消运行',
                  cancelLabel: '继续运行',
                  danger: true,
                  onConfirm: () => notify('已取消'),
                })
              }
            >
              打开确认
            </Button>
          </Sample>
          <Sample label="普通确认">
            <Button
              onClick={() =>
                confirm({
                  title: '把陈晨设为管理员？',
                  body: '管理员可以管理成员、服务、预算和连接器，但看不到成员的对话。',
                  confirmLabel: '设为管理员',
                  onConfirm: () => notify('角色已更新'),
                })
              }
            >
              打开确认
            </Button>
          </Sample>
          <Sample label="长内容">
            <Button
              onClick={() =>
                openPanel(
                  '产品使用指南',
                  <div className="stack">
                    {Array.from({ length: 16 }, (_, index) => (
                      <p key={index}>从一个问题开始。在对话里引用文档和记录，查看来源，修改前先确认。</p>
                    ))}
                  </div>,
                )
              }
            >
              体验独立滚动
            </Button>
          </Sample>
        </div>
      </Section>
      <Section id={7} title="对话与结果" rule="结果先于过程；写入前必须确认；过期或已处理的卡片不能再点。">
        <div className="sample-grid">
          <Sample label="用户消息" wide>
            <MessageBubble role="user" text="整理一下本周产品进度。" />
          </Sample>
          <Sample label="生成中" wide>
            <MessageBubble text="我正在整理本周的任务…" streaming />
          </Sample>
          <Sample label="回复（朗读、新开会话）" wide>
            <MessageBubble text="本周完成 3 条任务，2 条在推进。" />
          </Sample>
          <Sample label="结果 · 记录" wide>
            <RecordsCard records={records.filter((record) => record.status !== '已完成').slice(0, 2)} />
          </Sample>
          <Sample label="结果 · 表格" wide>
            <RichTable records={records} />
          </Sample>
          <Sample label="结果 · 图表">
            <MiniChart />
          </Sample>
          <Sample label="结果 · 文件" wide>
            <ArtifactCard />
          </Sample>
          <Sample label="结果 · 图片、视频、音频" wide>
            <MediaResults />
          </Sample>
          <Sample label="过程 · 工具调用（运行中 / 完成 / 失败）" wide>
            <div className="stack">
              <ToolCard initial="running" />
              <ToolCard initial="done" />
              <ToolCard initial="failed" />
            </div>
          </Sample>
          <Sample label="过程 · 多步运行" wide>
            <RunCard running />
          </Sample>
          <Sample label="决定 · 批准" wide>
            <ApprovalCard />
          </Sample>
          <Sample label="决定 · 已批准 / 已过期" wide>
            <div className="stack">
              <ApprovalCard initial="accepted" />
              <ApprovalCard initial="expired" />
            </div>
          </Sample>
          <Sample label="10 秒后过期" wide>
            <ExpiringApproval />
          </Sample>
          <Sample label="决定 · 登录" wide>
            <RequestCard kind="login" />
          </Sample>
          <Sample label="决定 · 接管电脑" wide>
            <RequestCard kind="takeover" />
          </Sample>
          <Sample label="决定 · 提问" wide>
            <RequestCard kind="question" />
          </Sample>
          <Sample label="决定 · 修改提议" wide>
            <RequestCard kind="proposal" />
          </Sample>
          <Sample label="附件">
            <Attachment name="访谈记录.pdf" size={248000} onClick={() => notify('预览')} />
          </Sample>
          <Sample label="代码" wide>
            <CodeBlock />
          </Sample>
        </div>
        <div className="lab-live-chat">
          <header>
            <h3>完整对话</h3>
            <p className="muted small">切换体验状态：输入、@、/、语音、附件、停止、重试与各种「需要你」。</p>
          </header>
          <div className="chat-demo-frame">
            <ChatPage />
          </div>
        </div>
      </Section>
      <p className="lab-end muted small">所有修改只作用于当前原型。顶部「重置」恢复初始数据。</p>
    </PageFrame>
  );
}
function ContextMenuDemo() {
  const { notify } = useDesign();
  const [pinned, setPinned] = useState(false);
  const menu = useContextMenu([
    { label: pinned ? '取消置顶' : '置顶', icon: <Pin size={15} />, onClick: () => setPinned(!pinned) },
    { label: '重命名', icon: <Pencil size={15} />, onClick: () => notify('在原处输入新名字') },
    '-',
    {
      label: '删除',
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: () => notify('已删除', { label: '撤销', onClick: () => notify('已恢复') }),
    },
  ]);
  return (
    <div className="demo-sidebar">
      <button className={`sidebar-item ${menu.open ? 'menu-open' : ''}`} {...menu.handlers}>
        {pinned ? <Pin size={14} /> : <Hash size={15} />}
        <span className="sidebar-item-title">右键这一行</span>
      </button>
      {menu.menu}
    </div>
  );
}
function ExpiringApproval() {
  const [key, setKey] = useState(0);
  return (
    <div className="stack">
      <ApprovalCard key={key} expiresAt={Date.now() + 10000} />
      <Button kind="ghost" onClick={() => setKey((value) => value + 1)}>
        重新计时
      </Button>
    </div>
  );
}
