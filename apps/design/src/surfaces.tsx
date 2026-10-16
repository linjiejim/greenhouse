import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowUp,
  BookOpen,
  Copy,
  FileText,
  Grid2X2,
  Keyboard,
  MessageCircle,
  Mic,
  MicOff,
  Signal,
  Smartphone,
  Table2,
  X,
} from 'lucide-react';
import { Badge, Button, ChatCard, IconButton, Input, Menu, Segmented, Switch, TextArea } from '@greenhouse/ui/kit';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { agents, documents, pendingRequests, skills, type DesignRequest } from './data';
import { useDesign } from './context';
import { FaceVerification } from './components';

function Scene({
  label,
  device = 'desktop',
  dark = false,
  children,
}: {
  label: string;
  device?: 'desktop' | 'phone' | 'watch';
  dark?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className={`surface-scene surface-scene-${device}`}>
      <div
        className={`surface-frame surface-${device}`}
        data-theme={dark ? 'dark' : undefined}
        data-narrow={device === 'phone' || undefined}
        role="region"
        aria-label={label}
      >
        {device === 'phone' && (
          <div className="surface-status">
            <strong>14:20</strong>
            <span className="surface-island" data-theme="light" />
            <span>
              <Signal size={16} /> 5G ▰
            </span>
          </div>
        )}
        {children}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}
function AgentAvatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <PlantAvatar plant={agents.find((item) => item.name === name)?.plant ?? 'sprout'} size={size} animate={false} />
  );
}
function LiveActivity() {
  const { runs, requests, openPhone } = useDesign();
  const run = runs.find((item) => item.state === '需要你') ?? runs.find((item) => item.state === '运行中');
  const waiting = run?.state === '需要你';
  const request = pendingRequests(requests).find((item) => item.agent === run?.agent);
  return (
    <div className={`surface-live stack tight ${waiting ? 'is-waiting' : 'is-running'}`}>
      <div className="surface-live-heading">
        <AgentAvatar name={run?.agent ?? 'Greeny'} size={20} />
        <strong>{run?.agent ?? 'Greeny'} · 后台运行</strong>
        <span className="surface-live-state">{waiting ? '等你批准' : (run?.state ?? '已完成')}</span>
      </div>
      <p>{run?.title ?? '暂时没有运行'}</p>
      <progress aria-label="运行进度" max={100} value={run?.progress ?? (run ? 58 : 100)} />
      <div className="surface-live-footer">
        <span className="muted small">{run ? '第 4 / 7 步' : '所有工作已完成'}</span>
        {waiting && (
          <button className="surface-open-pill" onClick={() => openPhone(request?.conversation ?? 'main')}>
            打开
          </button>
        )}
      </div>
    </div>
  );
}
function HoldApproval({ request }: { request: DesignRequest }) {
  const { decide } = useDesign();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  const start = () => {
    if (timer.current || request.state !== 'pending') return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      decide(request.id, 'accepted');
    }, 800);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      className={`watch-hold ${holding ? 'is-holding' : ''}`}
      kind="primary"
      disabled={request.state !== 'pending'}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onBlur={cancel}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (!event.repeat) start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <span>
        {request.state === 'accepted'
          ? '已批准'
          : request.state === 'rejected'
            ? '已拒绝'
            : request.state === 'pending'
              ? '按住批准'
              : '已过期'}
      </span>
    </Button>
  );
}
function QuickLaunch() {
  const { records, navigate, openDocument, openRecord } = useDesign();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [agent, setAgent] = useState(0);
  const [reply, setReply] = useState(false);
  const [closed, setClosed] = useState(false);
  const matches = [
    ...documents.map((item) => ({ title: item.title, kind: '文档', open: () => openDocument(item.id) })),
    ...records.map((item) => ({ title: item.title, kind: '记录', open: () => openRecord(item) })),
    ...agents.map((item) => ({
      title: item.name,
      kind: 'Agent',
      open: () => navigate('chat', item.id === 'greeny' ? 'main' : `agent:${item.id}`),
    })),
  ]
    .filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 5);
  const openSelected = () => (index === 0 ? setReply(true) : matches[index - 1]?.open());
  if (closed) return <Button onClick={() => setClosed(false)}>快捷启动 ⌘⇧Space</Button>;
  return (
    <div
      className="surface-launch stack"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setIndex((value) => (value + (event.key === 'ArrowDown' ? 1 : matches.length)) % (matches.length + 1));
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.metaKey || event.ctrlKey) openSelected();
          else setReply(true);
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          setAgent((value) => (value + (event.shiftKey ? agents.length - 1 : 1)) % agents.length);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setClosed(true);
        }
      }}
    >
      <div className="surface-launch-input">
        <button
          className="surface-agent-chip"
          aria-label={`当前：${agents[agent].name}`}
          onClick={() => setAgent((value) => (value + 1) % agents.length)}
        >
          <AgentAvatar name={agents[agent].name} size={20} />
          {agents[agent].name} ⌄
        </button>
        <Input
          aria-label="快捷启动"
          placeholder="问一句，或搜索…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
            setReply(false);
          }}
        />
      </div>
      {reply && (
        <div className="surface-launch-reply stack tight">
          <p>{agents[agent].name}：我找到了相关资料，可以继续整理。</p>
          <Button
            onClick={() => navigate('chat', agents[agent].id === 'greeny' ? 'main' : `agent:${agents[agent].id}`)}
          >
            在主窗口继续
          </Button>
        </div>
      )}
      <button className={`surface-row ${index === 0 ? 'is-selected' : ''}`} onClick={() => setReply(true)}>
        <ArrowUp size={16} />
        <span>
          问 Greeny <span className="muted">{query}</span>
        </span>
        <span className="surface-meta" aria-hidden="true">
          ↵
        </span>
      </button>
      <span className="surface-section-label">搜索</span>
      {matches.map((item, i) => (
        <button
          className={`surface-row ${index === i + 1 ? 'is-selected' : ''}`}
          key={`${item.kind}:${item.title}`}
          onClick={item.open}
        >
          {item.kind === '文档' ? (
            <BookOpen size={16} />
          ) : item.kind === '记录' ? (
            <Table2 size={16} />
          ) : (
            <MessageCircle size={16} />
          )}
          <span>{item.title}</span>
          <span className="surface-meta">{item.kind}</span>
        </button>
      ))}
      <span className="muted small">↵ 问 · ↑↓ 选择 · ⌘↵ 打开所选 · Tab 换 Agent · Esc 关闭</span>
    </div>
  );
}
function DesktopScenes() {
  const { requests, runs, decide, navigate, notify, openRun } = useDesign();
  const pending = pendingRequests(requests);
  const tier2 = pending.find((item) => item.tier === 2);
  const [instruction, setInstruction] = useState('');
  return (
    <div className="surface-gallery">
      <Scene label="菜单栏与通知">
        <div className="surface-menubar">
          <strong>Greenhouse</strong>
          <span>文件</span>
          <span>编辑</span>
          <span>前往</span>
          <span>窗口</span>
          <span className="grow" />
          <span className="surface-tray-anchor">
            <GreenhouseMark />
            {pending.length > 0 && <i className="surface-dot warning" />}
          </span>
          <span className="surface-menu-time">周五 14:20</span>
        </div>
        <div className="surface-mini-window">
          <div className="surface-mini-rail">
            <GreenhouseMark />
            <MessageCircle size={20} />
            <BookOpen size={20} />
            <Table2 size={20} />
            <Grid2X2 size={20} />
          </div>
          <div className="surface-mini-agents">
            {agents.slice(0, 3).map((item) => (
              <div className={`surface-row ${item.id === 'greeny' ? 'is-selected' : ''}`} key={item.id}>
                <AgentAvatar name={item.name} />
                <strong>{item.name}</strong>
              </div>
            ))}
          </div>
          <div className="surface-mini-chat">
            <span className="surface-chat-message">帮我更新本周任务状态</span>
            <div className="surface-chat-card">
              <ChatCard
                title={tier2 ? '更新任务状态' : '任务已更新'}
                status={tier2 ? '需要你' : '已完成'}
                attention={!!tier2}
              >
                <span className="muted small">Greeny · 产品计划</span>
              </ChatCard>
            </div>
          </div>
        </div>
        <div className="surface-tray">
          <span className="surface-section-label">需要你</span>
          {pending.map((item) => (
            <button className="surface-row" key={item.id} onClick={() => navigate('chat', item.conversation)}>
              <i className="surface-dot warning" />
              <span>
                {item.agent} · {item.title}
              </span>
            </button>
          ))}
          <span className="surface-section-label">运行中</span>
          {runs
            .filter((item) => item.state === '运行中')
            .map((item) => (
              <button className="surface-row" key={item.id} onClick={() => openRun(item.id)}>
                <i className="surface-dot success" />
                <span>{item.agent} · 第 4 / 7 步</span>
                <span className="surface-meta">{item.time}</span>
              </button>
            ))}
          <hr />
          <button className="surface-row" onClick={() => navigate('chat', 'new')}>
            新会话<span className="surface-meta">⌘N</span>
          </button>
          <button
            className="surface-row"
            onClick={() => document.querySelector<HTMLInputElement>('[aria-label="快捷启动"]')?.focus()}
          >
            快捷启动<span className="surface-meta">⌘⇧Space</span>
          </button>
          <button className="surface-row" onClick={() => navigate('chat', 'main')}>
            打开 Greenhouse<span className="surface-meta">⌘G</span>
          </button>
          <hr />
          <button className="surface-row" onClick={() => notify('Greenhouse 已退出，后台运行继续')}>
            退出
          </button>
        </div>
        <div className="surface-banner" aria-label="系统通知">
          <GreenhouseMark />
          <div className="surface-banner-copy">
            <strong>{tier2?.agent ?? 'Greenhouse'}</strong>
            <span>{tier2 ? '请你批准一个操作' : '已处理所有第 2 档请求'}</span>
          </div>
          {tier2 && (
            <div className="surface-banner-actions">
              <button className="surface-row" onClick={() => decide(tier2.id, 'accepted')}>
                批准
              </button>
              <Menu
                label="选项"
                trigger="选项"
                items={[
                  { label: '拒绝', onClick: () => decide(tier2.id, 'rejected') },
                  { label: '打开', onClick: () => navigate('chat', tier2.conversation) },
                ]}
              />
            </div>
          )}
        </div>
      </Scene>
      <Scene label="快捷启动">
        <QuickLaunch />
      </Scene>
      <Scene label="划词条">
        <div className="surface-document">
          <div className="surface-document-title">
            <FileText size={16} /> 本周产品计划
          </div>
          <p>本周先完善成员邀请，再检查数据导入和移动端导航。</p>
          <p>
            我们会优先处理 <mark>成员邀请和权限提示</mark>，让每一步都有清楚的反馈。
          </p>
          <div className="surface-selection-bar">
            <button className="surface-row" onClick={() => navigate('chat', 'main')}>
              <AgentAvatar name="Greeny" size={20} />
              <strong>问 Greeny</strong>
            </button>
            {skills.slice(0, 3).map((item) => (
              <button className="surface-row" key={item.id} onClick={() => notify(`已交给 Greeny：${item.name}`)}>
                {item.name}
              </button>
            ))}
            <button className="surface-row" onClick={() => notify('已存到知识库')}>
              存到知识库
            </button>
            <Menu items={[{ label: '复制', onClick: () => notify('已复制所选文字') }]} />
          </div>
          <p className="muted">完成后，再安排下一轮的验收与反馈整理。</p>
        </div>
      </Scene>
      <Scene label="截图面板">
        <div className="surface-menubar">
          <strong>终端</strong>
          <span>Shell</span>
          <span>编辑</span>
          <span className="grow" />
          <span>14:20</span>
        </div>
        <div className="surface-terminal">
          <span className="muted">greenhouse — dev</span>
          <p>$ pnpm dev</p>
          <p>Starting development server…</p>
          <p className="surface-terminal-error">
            Error: ECONNREFUSED 127.0.0.1:5432
            <br />
            at TCPConnectWrap.afterConnect
          </p>
          <p className="muted">Waiting for changes…</p>
        </div>
        <div className="surface-capture" aria-label="截图选区" />
        <div className="surface-capture-panel">
          <div className="surface-capture-thumb">
            <span>ECONNREFUSED</span>
            <span>127.0.0.1:5432</span>
          </div>
          <div className="stack tight grow">
            <Input
              aria-label="截图指令"
              placeholder="说一句要做什么…"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
            />
            <div className="surface-capture-actions">
              <Button onClick={() => notify('截图已存到知识库')}>存到知识库</Button>
              <Button onClick={() => notify('截图已复制')}>
                <Copy size={16} />
                复制
              </Button>
              <Button kind="primary" onClick={() => notify('已发给 Greeny')}>
                发给 Greeny
              </Button>
            </div>
          </div>
        </div>
      </Scene>
    </div>
  );
}
function PhoneScenes({ previews }: { previews: boolean }) {
  const { requests, runs, decide, openPhone, notify } = useDesign();
  const pending = pendingRequests(requests);
  const request = pending[0];
  const [expanded, setExpanded] = useState(false);
  const [verifying, setVerifying] = useState<{ id: string; decision: 'accepted' | 'rejected' } | null>(null);
  const [shareMode, setShareMode] = useState('交给 Agent');
  const [agent, setAgent] = useState('Greeny');
  const [instruction, setInstruction] = useState('');
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [typing, setTyping] = useState(false);
  const running = runs.filter((item) => item.state === '运行中');
  return (
    <div className="surface-gallery">
      <Scene label="锁屏" device="phone" dark>
        <div className="surface-wallpaper stack">
          <p className="surface-date">10 月 16 日 周五</p>
          <strong className="surface-clock">14:20</strong>
          <div className="row">
            <Button className="surface-complication" onClick={() => openPhone(request?.conversation ?? 'main')}>
              <span className="watch-count">
                {pending.length}
                <span className="small">需要你</span>
              </span>
            </Button>
            <Button onClick={() => openPhone(request?.conversation ?? 'main')}>
              下一件事
              <br />
              {request?.title ?? '都处理好了'}
            </Button>
          </div>
          <LiveActivity />
          {request ? (
            <div className="stack tight" key={request.id} aria-label="锁屏通知">
              <div className="surface-notification">
                <div className="surface-notification-heading">
                  <GreenhouseMark />
                  <strong>Greenhouse</strong>
                  <span className="surface-meta">现在</span>
                </div>
                <button className="surface-row" onClick={() => setExpanded(!expanded)}>
                  {previews ? request.title : `${request.agent}：请你批准一个操作`}
                </button>
              </div>
              {expanded && (
                <div className="surface-notification-actions">
                  {request.kind === 'approve' && request.tier === 2 && (
                    <>
                      <button
                        className="surface-row"
                        aria-label="批准（需解锁）"
                        onClick={() => setVerifying({ id: request.id, decision: 'accepted' })}
                      >
                        批准<span className="surface-meta">需解锁</span>
                      </button>
                      <button
                        className="surface-row"
                        aria-label="拒绝（需解锁）"
                        onClick={() => setVerifying({ id: request.id, decision: 'rejected' })}
                      >
                        拒绝<span className="surface-meta">需解锁</span>
                      </button>
                    </>
                  )}
                  <button className="surface-row" onClick={() => openPhone(request.conversation)}>
                    打开
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Badge tone="success">都处理好了</Badge>
          )}
        </div>
        {verifying && (
          <FaceVerification
            onVerified={() => {
              decide(verifying.id, verifying.decision);
              setVerifying(null);
              setExpanded(false);
            }}
          />
        )}
      </Scene>
      <Scene label="主屏幕小组件" device="phone">
        <div className="surface-wallpaper stack">
          <button className="surface-widget" onClick={() => openPhone(request?.conversation ?? 'main')}>
            <span className="surface-widget-heading">
              <GreenhouseMark />
              <strong>Greenhouse</strong>
            </span>
            <span className="surface-widget-halves">
              <span>
                <span className="surface-warning">需要你</span>
                <strong className="surface-widget-count surface-warning">{pending.length}</strong>
                <span>{request?.title ?? '都处理好了'}</span>
              </span>
              <span>
                <span className="muted">运行中</span>
                <strong className="surface-widget-count">{running.length}</strong>
                <span>{running[0]?.title ?? '暂时没有运行'}</span>
              </span>
            </span>
          </button>
          <div className="surface-app-grid" aria-hidden="true">
            {Array.from({ length: 16 }, (_, i) => (
              <span key={i}>
                <span>
                  {i % 3 === 0 ? (
                    <MessageCircle size={24} />
                  ) : i % 3 === 1 ? (
                    <BookOpen size={24} />
                  ) : (
                    <Grid2X2 size={24} />
                  )}
                </span>
                <i />
              </span>
            ))}
          </div>
          <div className="surface-home-dock" aria-hidden="true">
            <MessageCircle />
            <BookOpen />
            <Grid2X2 />
            <Table2 />
          </div>
        </div>
      </Scene>
      <Scene label="分享面板" device="phone">
        <div className="surface-web stack">
          <span className="muted small">example.com / 访谈</span>
          <h2>把反馈变成下一步</h2>
          <p>保留原话，找到共同的问题，再安排任务。</p>
        </div>
        <div className="surface-share stack">
          <Segmented label="分享方式" items={['交给 Agent', '存到知识库']} value={shareMode} onChange={setShareMode} />
          {shareMode === '交给 Agent' && (
            <div className="row wrap">
              {agents.map((item) => (
                <button
                  className="surface-agent-chip"
                  key={item.id}
                  aria-pressed={agent === item.name}
                  onClick={() => setAgent(item.name)}
                >
                  <AgentAvatar name={item.name} size={24} />
                  {item.name}
                </button>
              ))}
            </div>
          )}
          <TextArea
            aria-label="分享指令"
            placeholder="说一句要做什么…"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <Button
            kind="primary"
            onClick={() => notify(shareMode === '交给 Agent' ? `已交给 ${agent}` : '已存到知识库')}
          >
            发送
          </Button>
        </div>
      </Scene>
      <Scene label="语音模式" device="phone" dark>
        <div className="surface-voice stack">
          <Badge tone="info">{ended ? '已结束' : muted ? '已静音' : '正在听'}</Badge>
          <div className="surface-orb" aria-hidden="true" />
          <p className="muted">你：今天有什么要处理？</p>
          <p>
            {ended
              ? '下次再聊。'
              : pending.length
                ? '有一件事需要你在屏幕上确认'
                : '今天的任务都处理好了。客户访谈正在整理，完成后我会告诉你。'}
          </p>
          {typing && <Input aria-label="语音文字输入" placeholder="输入消息…" />}
          <div className="surface-voice-controls">
            <button className="surface-voice-button" aria-label="键盘" onClick={() => setTyping(!typing)}>
              <Keyboard size={24} />
            </button>
            <button
              className="surface-voice-button"
              aria-label={muted ? '取消静音' : '静音'}
              aria-pressed={muted}
              onClick={() => setMuted(!muted)}
            >
              {muted ? <MicOff size={24} /> : <Mic size={24} />}
            </button>
            <button className="surface-voice-button is-end" aria-label="结束" onClick={() => setEnded(true)}>
              <X size={24} />
            </button>
          </div>
        </div>
      </Scene>
    </div>
  );
}
function WatchScenes({ previews }: { previews: boolean }) {
  const { requests, runs, decide, openPhone, cancelRun } = useDesign();
  const pending = pendingRequests(requests);
  const tier2 = requests.find((item) => item.tier === 2)!;
  const tier3 = requests.find((item) => item.tier === 3)!;
  const first = pending[0];
  const running = runs.filter((item) => item.state === '运行中');
  const run = runs.find((item) => item.id === 'run-2')!;
  const [dictated, setDictated] = useState(false);
  const [detail, setDetail] = useState(false);
  const openDetail = () => {
    setDetail(true);
    document.getElementById('watch-tier2')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  };
  return (
    <div className="surface-gallery">
      <Scene label="表盘" device="watch" dark>
        <p className="surface-date">周五 16 日</p>
        <strong className="surface-watch-clock">14:20</strong>
        <div className="row">
          <Button className="surface-ring warning" onClick={openDetail}>
            <span className="watch-count">
              {pending.length}
              <span className="small">需要你</span>
            </span>
          </Button>
          <Button onClick={() => openPhone('main')}>{running.length} 运行中</Button>
        </div>
        <Button className="watch-next" onClick={() => openPhone(first?.conversation ?? 'main')}>
          <span>下一件事</span>
          <span className="small">{first?.title ?? '都处理好了'}</span>
        </Button>
      </Scene>
      <Scene label="现在" device="watch" dark>
        <strong>现在</strong>
        <div className="watch-scroll stack tight">
          {pending.map((item) => (
            <button
              className="surface-row watch-list-row watch-pending"
              key={item.id}
              onClick={() => (item.tier === 2 ? openDetail() : openPhone(item.conversation))}
            >
              <AgentAvatar name={item.agent} />
              <span className="watch-list-copy">
                <strong>{item.title}</strong>
                <span>{item.agent} · 需要你</span>
              </span>
            </button>
          ))}
          {running.map((item) => (
            <button
              className="surface-row watch-list-row"
              key={item.id}
              onClick={() => document.getElementById('watch-run')?.scrollIntoView({ block: 'nearest' })}
            >
              <AgentAvatar name={item.agent} />
              <span className="watch-list-copy">
                <strong>{item.title}</strong>
                <span>运行中 · 第 4 / 7 步</span>
              </span>
            </button>
          ))}
        </div>
      </Scene>
      <Scene label="第 2 档请求" device="watch" dark>
        <div id="watch-tier2" className="stack tight">
          <strong>{tier2.title}</strong>
          <span className="muted small">{tier2.agent}</span>
          <p className="small">{tier2.effect}</p>
          {detail && <Badge tone="warning">按住确认</Badge>}
          <HoldApproval request={tier2} />
          <div className="row">
            <Button disabled={tier2.state !== 'pending'} onClick={() => decide(tier2.id, 'rejected')}>
              拒绝
            </Button>
            <IconButton label="在 iPhone 上打开" onClick={() => openPhone(tier2.conversation)}>
              <Smartphone size={18} />
            </IconButton>
          </div>
        </div>
      </Scene>
      <Scene label="第 3 档请求" device="watch" dark>
        <strong>{tier3.title}</strong>
        <Badge tone="warning">对外，不能撤回</Badge>
        <p>这类操作要在 iPhone 上确认</p>
        <Button onClick={() => openPhone(tier3.conversation)}>在 iPhone 上打开</Button>
      </Scene>
      <Scene label="说一句" device="watch" dark>
        <strong>说一句</strong>
        <IconButton label="开始听写" onClick={() => setDictated(true)}>
          <Mic size={36} />
        </IconButton>
        {dictated ? (
          <>
            <p className="small">明早 9 点提醒我把预算表发给财务</p>
            <p className="small">好，已加一个定时：明天 9:00。</p>
          </>
        ) : (
          <p className="muted">抬腕，说一句。</p>
        )}
      </Scene>
      <Scene label="运行详情" device="watch" dark>
        <div id="watch-run" className="stack tight">
          <strong>{run.title}</strong>
          <div className="surface-progress-ring" style={{ '--run-progress': run.progress ?? 0 } as CSSProperties}>
            <span>{run.state === '已取消' ? '已取消' : `${run.progress ?? 0}%`}</span>
          </div>
          <div className="small">
            {run.steps?.slice(-3).map((step) => (
              <p key={step}>{step}</p>
            ))}
          </div>
          <Button disabled={run.state === '已取消'} onClick={() => cancelRun(run.id)}>
            取消
          </Button>
        </div>
      </Scene>
      <Scene label="长通知" device="watch" dark>
        <div className="surface-notification-heading">
          <GreenhouseMark />
          <span className="small">Greenhouse · 现在</span>
        </div>
        <div className="surface-watch-bubble">
          <strong>{first?.agent ?? 'Greeny'}</strong>
          <p>{previews ? (first?.title ?? '都处理好了') : '请你批准一个操作'}</p>
        </div>
        {first && (
          <div className="surface-watch-actions">
            {first.tier === 2 && (
              <Button kind="primary" onClick={openDetail}>
                批准
              </Button>
            )}
            <Button onClick={() => openPhone(first.conversation)}>打开</Button>
          </div>
        )}
      </Scene>
      <Scene label="智能叠放" device="watch" dark>
        <strong>14:20</strong>
        <LiveActivity />
      </Scene>
    </div>
  );
}
export function SurfacesPage() {
  const [tab, setTab] = useState('桌面 App');
  const [previews, setPreviews] = useState(false);
  return (
    <div className="surfaces-page">
      <header className="surface-heading">
        <h1>多端</h1>
        <Segmented label="设备场景" items={['桌面 App', '手机', '手表']} value={tab} onChange={setTab} />
        <div className="row">
          <span className="small">通知预览</span>
          <Switch label="通知预览" checked={previews} onChange={setPreviews} />
        </div>
      </header>
      <div className="surface-scroll">
        {tab === '桌面 App' ? (
          <DesktopScenes />
        ) : tab === '手机' ? (
          <PhoneScenes previews={previews} />
        ) : (
          <WatchScenes previews={previews} />
        )}
      </div>
    </div>
  );
}
