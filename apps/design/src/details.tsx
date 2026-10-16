/** Drawer / sheet contents. One drawer at a time; editing happens in place (docs/design-system/patterns.md, 列表与详情). */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Download,
  ExternalLink,
  FileText,
  Lock,
  MonitorPlay,
  Play,
  Plus,
  ThumbsUp,
} from 'lucide-react';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import {
  Badge,
  Button,
  ChatCard,
  Empty,
  Field,
  HelpHint,
  IconButton,
  Input,
  Menu,
  OverlayActions,
  SecretField,
  Segmented,
  Select,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
} from '@greenhouse/ui/kit';
import { ApprovalCard, MiniChart, RecordEditor, Steps } from './components';
import { useDesign } from './context';
import {
  capabilities,
  documents,
  presets,
  schedules,
  workspaceProviders,
  type AgentItem,
  type Capability,
  type ModuleId,
  type ProviderInstance,
  type RecordItem,
  type RunItem,
} from './data';

function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="key-value">
      {items.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RecordDrawer({
  item,
  editing,
  onEdit,
  onSave,
  onDirty,
  onCancel,
}: {
  item: RecordItem;
  editing: boolean;
  onEdit: () => void;
  onSave: (item: RecordItem) => void;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
}) {
  const { notify, openRun } = useDesign();
  if (editing) return <RecordEditor item={item} onSave={onSave} onDirty={onDirty} onCancel={onCancel} />;
  return (
    <div className="stack">
      <div className="row">
        <StatusBadge status={item.status} />
        <span className="muted small">产品计划 / 任务 · {item.id}</span>
      </div>
      <KeyValue
        items={[
          ['负责人', item.owner],
          ['优先级', item.priority],
          ['开始', item.start],
          ['截止', item.date],
          ['说明', item.note || '—'],
        ]}
      />
      <section className="stack tight">
        <h3 className="small-title">活动</h3>
        <p className="muted small">林杰 创建了记录 · 10 月 8 日</p>
        <p className="muted small">卷卷 把状态改为「{item.status}」· 昨天</p>
      </section>
      <OverlayActions>
        <Menu
          label="更多操作"
          items={[
            {
              label: '交给 Agent',
              icon: <Bot size={15} />,
              onClick: () => {
                notify('已交给「卷卷」，在运行里查看进度', { label: '查看', onClick: () => openRun('run-2') });
              },
            },
            { label: '复制链接', onClick: () => notify('已复制记录链接') },
          ]}
        />
        <Button kind="primary" onClick={onEdit}>
          编辑
        </Button>
      </OverlayActions>
    </div>
  );
}

export function DocumentDetail({ document, onSaved }: { document: (typeof documents)[number]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(document.content);
  return (
    <div className="stack">
      <div className="row">
        <Badge>{document.kind}</Badge>
        <span className="muted small">
          {document.scope} · {document.folder} · {document.date}更新
        </span>
      </div>
      {editing ? (
        <TextArea
          aria-label="文档内容"
          rows={14}
          maxRows={24}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      ) : (
        <article className="document-content">
          {text
            .split('\n\n')
            .map((part, index) => (index % 2 === 0 ? <h3 key={index}>{part}</h3> : <p key={index}>{part}</p>))}
        </article>
      )}
      <OverlayActions>
        {editing ? (
          <>
            <Button onClick={() => setEditing(false)}>取消</Button>
            <Button
              kind="primary"
              onClick={() => {
                setEditing(false);
                onSaved();
              }}
            >
              保存
            </Button>
          </>
        ) : (
          <>
            <Button kind="ghost">
              在新页面打开 <ExternalLink size={14} />
            </Button>
            {document.kind === '文档' && (
              <Button kind="primary" onClick={() => setEditing(true)}>
                编辑
              </Button>
            )}
          </>
        )}
      </OverlayActions>
    </div>
  );
}

const templates = [
  { name: '研究员', plant: 'dandelion' as const },
  { name: '运营', plant: 'clover' as const },
  { name: '周报', plant: 'sunflower' as const },
  { name: '项目跟进', plant: 'fern' as const },
  { name: '空白', plant: 'opuntia' as const },
];
export function NewAgentForm({ onCreate }: { onCreate: (name: string) => void }) {
  const [template, setTemplate] = useState('研究员');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const formId = useId();
  return (
    <form
      id={formId}
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) {
          setError('请输入名字');
          return;
        }
        onCreate(name.trim());
      }}
    >
      <div className="template-grid" role="radiogroup" aria-label="模板">
        {templates.map((item) => (
          <button
            type="button"
            key={item.name}
            role="radio"
            aria-checked={template === item.name}
            className="template-card"
            onClick={() => setTemplate(item.name)}
          >
            <PlantAvatar plant={item.plant} size={36} animate={false} />
            {item.name}
          </button>
        ))}
      </div>
      <Field label="名字" error={error} required>
        <Input
          data-autofocus
          value={name}
          placeholder="例如：采购助手"
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
      </Field>
      <Field label="职责" help="一句话说明它负责什么。会显示在对话目录里，也会写进它的指令。">
        <Input defaultValue={template === '空白' ? '' : template} />
      </Field>
      <OverlayActions>
        <Button kind="primary" type="submit" form={formId}>
          创建
        </Button>
      </OverlayActions>
    </form>
  );
}

export function AgentProfile({ agent, initialTab }: { agent: AgentItem; initialTab?: string }) {
  const { navigate, notify } = useDesign();
  const tabs = ['资料', '能力', '记忆', '定时', '电脑', ...(agent.kind === '主 Agent' ? [] : ['发布']), '用量'];
  const [tab, setTab] = useState(initialTab && tabs.includes(initialTab) ? initialTab : '资料');
  const [computer, setComputer] = useState<'离线' | '运行中' | '等你接管'>(
    agent.status === '运行中' ? '运行中' : '离线',
  );
  const [published, setPublished] = useState(agent.kind === '公开');
  const [access, setAccess] = useState('可写，需确认');
  const [memories, setMemories] = useState(['林杰喜欢先看结论，再看依据。', '周报发给产品群，不发全员。']);
  const mine = agent.owner === '林杰';
  return (
    <div className="stack">
      <div className="row">
        <PlantAvatar plant={agent.plant} size={56} animate={false} />
        <div className="grow">
          <h3>{agent.name}</h3>
          <p className="muted small">
            {agent.role} · {agent.kind}
            {!mine && ` · ${agent.owner} 发布`}
          </p>
        </div>
        <Button
          kind="primary"
          onClick={() => navigate('chat', agent.kind === '主 Agent' ? 'main' : `agent:${agent.id}`)}
        >
          发消息
        </Button>
      </div>
      <Tabs items={tabs} value={tab} onChange={setTab} label="Agent 资料" />
      {tab === '资料' && (
        <>
          <p>{agent.description}</p>
          <Field label="指令" help="Agent 每次回复都会遵守。Agent 自己提出修改时，会先给你一张确认卡片。">
            <TextArea rows={5} readOnly={!mine} defaultValue={`你是${agent.name}，${agent.description}`} />
          </Field>
          {mine && (
            <OverlayActions>
              <Button kind="primary" onClick={() => notify('资料已保存')}>
                保存
              </Button>
            </OverlayActions>
          )}
        </>
      )}
      {tab === '能力' && (
        <>
          <Field label="技能" help="在对话里，这个 Agent 可以直接用这些技能。">
            <div className="row wrap">
              <Badge>整理周报</Badge>
              <Badge>PDF 报告生成</Badge>
              <Button kind="ghost">
                <Plus size={14} />
                添加
              </Button>
            </div>
          </Field>
          <Field label="连接器" help="只列出你已经连接的账号。Agent 用它们时，写操作会先请你确认。">
            <div className="row wrap">
              <Badge tone="success">GitHub</Badge>
              <Badge>Notion · 未连接</Badge>
            </div>
          </Field>
          <Field label="权限">
            <Select label="权限" value={access} options={['只读', '可写，需确认', '可写']} onChange={setAccess} />
          </Field>
          <details className="disclosure">
            <summary>高级 · 默认工具</summary>
            <p className="muted small">知识库读写、表格读写、网页搜索、生成图片、计算。</p>
          </details>
        </>
      )}
      {tab === '记忆' &&
        (memories.length ? (
          <div className="list-card">
            {memories.map((memory) => (
              <div className="list-row" key={memory}>
                <span className="grow">{memory}</span>
                <Button kind="ghost" onClick={() => setMemories((value) => value.filter((item) => item !== memory))}>
                  忘记
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="还没有记忆" description="对话里确认过的长期偏好会出现在这里。" />
        ))}
      {tab === '定时' && (
        <>
          <div className="list-card">
            {schedules
              .filter((item) => item.agent === agent.name || agent.kind === '主 Agent')
              .map((item) => (
                <div className="list-row" key={item.id}>
                  <span className="grow">
                    <strong>{item.title}</strong>
                    <span className="muted small">
                      {item.rule} · 下次 {item.next}
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
          <Button onClick={() => notify('也可以直接在对话里说：「每周五 10 点帮我写周报」')}>
            <Plus size={14} />
            添加定时
          </Button>
        </>
      )}
      {tab === '电脑' && (
        <>
          <div className="row">
            <StatusBadge status={computer} />
            <HelpHint label="电脑">
              每个 Agent 有一台云电脑，由「沙箱」服务提供；空闲 30 分钟后自动停止，文件会保留。
            </HelpHint>
          </div>
          <div className="computer-preview">
            <div className="computer-chrome">
              <span />
              <span />
              <span />
              {agent.name} 的电脑
            </div>
            <div className="computer-content">
              {computer === '离线' ? (
                <Empty title="电脑已停止" description="下次需要时会自动启动。" />
              ) : (
                <>
                  <GreenhouseMark />
                  <p>{computer === '运行中' ? '正在下载报价单…' : '你正在操作这台电脑'}</p>
                </>
              )}
            </div>
          </div>
          <div className="row end">
            {computer === '离线' && (
              <Button kind="primary" onClick={() => setComputer('运行中')}>
                <MonitorPlay size={15} />
                启动
              </Button>
            )}
            {computer === '运行中' && (
              <Button kind="primary" onClick={() => setComputer('等你接管')}>
                接管
              </Button>
            )}
            {computer === '等你接管' && (
              <Button kind="primary" onClick={() => setComputer('运行中')}>
                交还
              </Button>
            )}
          </div>
        </>
      )}
      {tab === '发布' && (
        <>
          <div className="setting-row">
            <div>
              <strong>发布给同事</strong>
              <p className="muted small">同事和它对话时，看不到你的私有资料与对话。</p>
            </div>
            <Switch label="发布给同事" checked={published} onChange={setPublished} />
          </div>
          {published && (
            <>
              <Field label="受众">
                <Select label="受众" value="产品组" options={['全员', '产品组', '指定成员']} onChange={() => {}} />
              </Field>
              <Field label="月度预算" help="公开 Agent 的用量单独记账，达到上限后暂停回复。">
                <Input defaultValue="500,000 tokens" />
              </Field>
              <p className="row small">
                <ThumbsUp size={14} /> 92% 有帮助 · 本月 128 次回复
              </p>
            </>
          )}
        </>
      )}
      {tab === '用量' && <MiniChart title="本月 token（千）" />}
    </div>
  );
}

export function RunDetail({ run }: { run: RunItem }) {
  const { navigate, notify } = useDesign();
  const [state, setState] = useState(run.state);
  return (
    <div className="stack">
      <div className="row">
        <StatusBadge status={state} />
        <span className="muted small">
          {run.agent} · 来自{run.source} · {run.time}
        </span>
      </div>
      {state === '需要你' ? (
        <ApprovalCard onResult={(result) => setState(result === 'accepted' ? '已完成' : '已取消')} />
      ) : (
        <Steps running={state === '运行中'} />
      )}
      {state === '失败' && <p className="error">供应商门户的登录已过期。到「设置 → 密码库」更新后重试。</p>}
      {state === '已完成' && (
        <ChatCard
          icon={<FileText size={16} />}
          title="周报.md"
          meta="Markdown · 4 KB"
          footer={
            <Button kind="ghost" onClick={() => notify('已下载「周报.md」')}>
              <Download size={14} />
              下载
            </Button>
          }
        />
      )}
      <OverlayActions>
        {run.source === '对话' && (
          <Button kind="ghost" onClick={() => navigate('chat', 'agent:triage')}>
            打开来源对话
          </Button>
        )}
        {state === '失败' && (
          <Button kind="primary" onClick={() => setState('运行中')}>
            重试失败的步骤
          </Button>
        )}
        {state === '运行中' && <Button onClick={() => setState('已取消')}>取消运行</Button>}
      </OverlayActions>
    </div>
  );
}

function testResult(instance: ProviderInstance) {
  return instance.status === '不可用'
    ? '401 Unauthorized：Key 无效或已过期'
    : `可用 · ${180 + instance.name.length * 9} ms`;
}
export function ProviderDrawer({ capability, personal }: { capability: Capability; personal: boolean }) {
  const { notify } = useDesign();
  const meta = capabilities.find((item) => item.id === capability)!;
  const [instances, setInstances] = useState(personal ? [] : workspaceProviders[capability]);
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState(presets[capability][0]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [allowPersonal, setAllowPersonal] = useState(meta.personal);
  const move = (index: number, delta: number) =>
    setInstances((value) => {
      const next = [...value];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });
  return (
    <div className="stack">
      {personal && (
        <p className="muted small">
          现在使用：{workspaceProviders[capability][0]?.name ?? '浏览器自带'}（工作区）。加上自己的 Key
          后，只有你的调用会用它，用量记在你名下。
        </p>
      )}
      {instances.length > 0 && (
        <div className="list-card">
          {instances.map((instance, index) => (
            <div className="list-row" key={instance.id}>
              <span className="order-index">{index + 1}</span>
              <span className="grow">
                <strong>{instance.name}</strong>
                <span className="muted small">
                  {instance.preset} · {checks[instance.id] ?? instance.status}
                </span>
              </span>
              {instance.source === '环境变量' && (
                <Badge>
                  <Lock size={12} /> 环境变量
                </Badge>
              )}
              {!personal && instances.length > 1 && (
                <span className="row tight">
                  <IconButton label="上移" size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowUp size={14} />
                  </IconButton>
                  <IconButton
                    label="下移"
                    size="sm"
                    disabled={index === instances.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={14} />
                  </IconButton>
                </span>
              )}
              <Menu
                label={`${instance.name} 更多操作`}
                items={[
                  {
                    label: '测试连接',
                    onClick: () => setChecks((value) => ({ ...value, [instance.id]: testResult(instance) })),
                  },
                  ...(instance.source === '环境变量'
                    ? [{ label: '复制为可编辑', onClick: () => notify('已复制为工作区实例') }]
                    : [
                        {
                          label: '删除',
                          danger: true,
                          onClick: () => setInstances((value) => value.filter((item) => item.id !== instance.id)),
                        },
                      ]),
                ]}
              />
            </div>
          ))}
        </div>
      )}
      {!personal && instances.length > 1 && <p className="muted small">按顺序使用，前一个出错时自动换下一个。</p>}
      {!instances.length && !adding && (
        <Empty
          title={personal ? '还没有你自己的 Key' : '还没有配置'}
          description={personal ? undefined : '没有配置时，相关功能不会出现在界面上。'}
        />
      )}
      {adding ? (
        <form
          className="stack add-provider"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) {
              setError('请输入名称');
              return;
            }
            setInstances((value) => [
              ...value,
              {
                id: `p-${Date.now()}`,
                name: name.trim(),
                preset,
                source: personal ? '我的' : '工作区',
                status: '未测试',
              },
            ]);
            setAdding(false);
            setName('');
            notify('已添加，建议先测试连接');
          }}
        >
          <Field label="厂商">
            <Select label="厂商" value={preset} options={presets[capability]} onChange={setPreset} />
          </Field>
          <Field label="名称" error={error} required>
            <Input
              data-autofocus
              value={name}
              placeholder={`例如：${personal ? '我的' : '公司'} ${preset}`}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </Field>
          <Field label="地址" help="留空时使用厂商的默认地址。改地址后，必须重新填写 Key——Key 只会发往你填写的地址。">
            <Input placeholder="https://（可选）" />
          </Field>
          <SecretField label="API Key" configured={false} onSave={() => notify('Key 已保存，只写不读')} />
          {capability === 'llm' && (
            <Field label="模型">
              <Input defaultValue={preset === 'DeepSeek' ? 'deepseek-chat' : ''} placeholder="模型名称" />
            </Field>
          )}
          <div className="form-actions">
            <Button onClick={() => setAdding(false)}>取消</Button>
            <Button kind="primary" type="submit">
              添加
            </Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => setAdding(true)}>
          <Plus size={15} />
          {personal ? '添加我的 Key' : '添加实例'}
        </Button>
      )}
      {!personal && capability === 'llm' && (
        <section className="settings-section">
          <h2>默认模型</h2>
          <Field label="默认" help="对话和 Agent 默认用它。">
            <Select
              label="默认模型"
              value="公司 DeepSeek / deepseek-chat"
              options={['公司 DeepSeek / deepseek-chat', 'Claude / claude-sonnet-4-5']}
              onChange={() => {}}
            />
          </Field>
          <Field label="强模型" help="需要更强推理时使用，例如复杂分析。可以不设置。">
            <Select
              label="强模型"
              value="Claude / claude-sonnet-4-5"
              options={['未设置', 'Claude / claude-sonnet-4-5']}
              onChange={() => {}}
            />
          </Field>
        </section>
      )}
      {!personal && capability === 'sandbox' && (
        <section className="settings-section">
          <h2>电脑容量</h2>
          <div className="two-columns">
            <Field label="空闲多久后停止">
              <Input defaultValue="30 分钟" />
            </Field>
            <Field label="最多同时运行">
              <Input defaultValue="8 台" />
            </Field>
          </div>
        </section>
      )}
      {!personal && (
        <div className="setting-row">
          <div className="row">
            <strong>允许成员使用自己的 Key</strong>
            <HelpHint label="个人 Key">
              成员在「设置 → 我的服务」里添加。只有他自己的调用会用它，用量不计入组织预算。
            </HelpHint>
          </div>
          <Switch label="允许成员使用自己的 Key" checked={allowPersonal} onChange={setAllowPersonal} />
        </div>
      )}
    </div>
  );
}

export function CreatePanel({ module, onSave }: { module: ModuleId; onSave: (name: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState(module === 'knowledge' ? '文档' : module === 'skills' ? '模板' : '');
  const [error, setError] = useState('');
  const formId = useId();
  const label = module === 'admin' ? '邮箱' : '名称';
  return (
    <form
      id={formId}
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) {
          setError(`请输入${label}`);
          return;
        }
        if (module === 'admin' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
          setError('请输入有效的邮箱');
          return;
        }
        onSave(name.trim());
      }}
    >
      {module === 'knowledge' && (
        <Segmented label="类型" items={['文档', '文件夹', '上传文件']} value={kind} onChange={setKind} />
      )}
      {module === 'skills' && (
        <Field label="类型" help="模板只有说明和变量；技能包可以带文件和脚本，并有版本与安全扫描。">
          <Segmented label="技能类型" items={['模板', '技能包']} value={kind} onChange={setKind} />
        </Field>
      )}
      <Field label={label} error={error} required>
        <Input
          data-autofocus
          value={name}
          placeholder={module === 'admin' ? 'name@example.com' : ''}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
      </Field>
      {module === 'apps' && (
        <Field label="基于表格" help="应用只是表格的一组页面；数据仍保存在表格里。">
          <Select label="基于表格" value="IT 支持" options={['IT 支持', '产品计划', '采购管理']} onChange={() => {}} />
        </Field>
      )}
      {module === 'admin' && (
        <Field label="角色">
          <Select label="角色" value="成员" options={['成员', '管理员']} onChange={() => {}} />
        </Field>
      )}
      <OverlayActions>
        <Button kind="primary" type="submit" form={formId}>
          {module === 'admin' ? '发送邀请' : '创建'}
        </Button>
      </OverlayActions>
    </form>
  );
}

/** Sign-in: the product name, two fields and one large button. SSO only when it is configured. */
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('super@greenhouse.local');
  const [password, setPassword] = useState('greenhouse');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="login-page">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (!['super@greenhouse.local', 'team@greenhouse.local'].includes(email) || password !== 'greenhouse') {
            setError('邮箱或密码不正确');
            return;
          }
          setBusy(true);
          timer.current = setTimeout(onLogin, 600);
        }}
      >
        <GreenhouseMark />
        <h1>Greenhouse</h1>
        <Field label="邮箱">
          <Input
            size="lg"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError('');
            }}
            autoComplete="username"
          />
        </Field>
        <Field label="密码" error={error}>
          <Input
            size="lg"
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError('');
            }}
            autoComplete="current-password"
          />
        </Field>
        <Button type="submit" kind="primary" size="lg" loading={busy}>
          登录
        </Button>
        <div className="login-divider">或</div>
        <Button size="lg" onClick={() => setError('本地原型没有连接飞书')}>
          飞书登录
        </Button>
      </form>
    </div>
  );
}
