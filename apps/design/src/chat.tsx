import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  AtSign,
  AudioLines,
  Bell,
  ChevronRight,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Film,
  Hash,
  ImageIcon,
  Info,
  LockKeyhole,
  Mic,
  MonitorPlay,
  Paperclip,
  Play,
  Slash,
  Split,
  Square,
  Table2,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  X,
} from 'lucide-react';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import {
  Button,
  ChatCard,
  ErrorBox,
  IconButton,
  Menu,
  Skeleton,
  Spinner,
  StatusBadge,
  TextArea,
} from '@greenhouse/ui/kit';
import { avatar } from '@greenhouse/ui/tokens';
import { ApprovalCard, MiniChart, NativeSelect, RequestCard, Steps } from './components';
import { useDesign } from './context';
import { useRowMenus } from './shell';
import {
  agents,
  rooms,
  scenarioOptions,
  skills,
  downloadText,
  type AgentItem,
  type RecordItem,
  type Scenario,
} from './data';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  rich?: 'overview' | 'tools' | 'approval' | 'requests' | 'rich' | 'media' | 'artifact' | 'error';
  state?: 'streaming' | 'stopped' | 'done';
  files?: { name: string; size: number; url?: string }[];
};
const response = '本周完成 3 条任务，2 条在推进。建议先处理高优先级的「检查数据导入错误」，再确认移动端导航。';
const scenarioMessages = (scenario: Scenario): Message[] => {
  if (scenario === 'empty' || scenario === 'stream') return [];
  return [
    {
      id: 'initial-user',
      role: 'user',
      text:
        scenario === 'artifact'
          ? '帮我写一份简洁的周报，顺便准备可以下载的版本。'
          : scenario === 'approval'
            ? '把已经完成的任务更新一下。'
            : scenario === 'media'
              ? '给发布会做一张封面图、一段 5 秒的开场视频，再把开场白读一遍。'
              : scenario === 'requests'
                ? '去供应商门户把这周的报价单下载下来。'
                : '看看产品改版的进度。',
    },
    {
      id: 'initial-assistant',
      role: 'assistant',
      text:
        scenario === 'error'
          ? ''
          : scenario === 'approval'
            ? '有 2 条任务可以标为已完成，请确认。'
            : scenario === 'media'
              ? '封面图和开场白已生成；视频还在后台渲染，完成后会通知你。'
              : scenario === 'requests'
                ? '门户要登录，还出现了人机验证，需要你帮一下。'
                : '本周完成 3 条任务，2 条在推进。建议先处理高优先级的导入检查。',
      rich: scenario === 'readonly' ? 'overview' : scenario,
      state: 'done',
    },
  ];
};

/** Who this conversation is with, from the module column selection. */
function useCounterpart() {
  const { selection } = useDesign();
  if (selection.startsWith('agent:')) {
    const agent = agents.find((item) => item.id === selection.slice(6))!;
    return {
      kind: 'agent' as const,
      agent,
      title: agent.name,
      sub: agent.status === '运行中' ? '运行中 · 生成周报' : agent.role,
    };
  }
  if (selection.startsWith('room:')) {
    const room = rooms.find((item) => item.id === selection.slice(5));
    return { kind: 'room' as const, agent: agents[0], title: room?.name ?? '新房间', sub: room?.members ?? '添加成员' };
  }
  if (selection.startsWith('chat:'))
    return { kind: 'chat' as const, agent: agents[0], title: selection.slice(5), sub: `会话 · ${agents[0].name}` };
  if (selection === 'new') return { kind: 'chat' as const, agent: agents[0], title: '新会话', sub: agents[0].name };
  return { kind: 'main' as const, agent: agents[0], title: agents[0].name, sub: '主线' };
}

export function ChatPage() {
  const {
    records,
    setRecords,
    notify,
    openPanel,
    openDocument,
    openAgent,
    headerLead,
    selection,
    mobile,
    navigate,
    needsYou,
  } = useDesign();
  const counterpart = useCounterpart();
  const menus = useRowMenus();
  const startEmpty = selection === 'new' || selection === 'room:new';
  const initialScenario: Scenario = selection === 'archived' ? 'readonly' : startEmpty ? 'empty' : 'overview';
  const [scenario, setScenario] = useState<Scenario>(initialScenario);
  const [messages, setMessages] = useState<Message[]>(() => scenarioMessages(initialScenario));
  const [draft, setDraft] = useState(() => sessionStorage.getItem('greenhouse-design-draft') || '');
  const [streaming, setStreaming] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; size: number; url?: string }[]>([]);
  const [picker, setPicker] = useState<'mention' | 'slash' | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [recording, setRecording] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const urls = useRef<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const activeStream = useRef('');
  const [away, setAway] = useState(false);
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    activeStream.current = '';
  };
  const stopRecording = () => {
    if (recordTimer.current) clearInterval(recordTimer.current);
    recordTimer.current = null;
    setRecording(0);
  };
  useEffect(() => {
    sessionStorage.removeItem('greenhouse-design-draft');
    const localUrls = urls.current;
    return () => {
      timers.current.forEach(clearTimeout);
      if (recordTimer.current) clearInterval(recordTimer.current);
      localUrls.forEach(URL.revokeObjectURL);
      window.speechSynthesis?.cancel();
    };
  }, []);
  useEffect(() => {
    if (!away)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming, away]);
  const loadScenario = (next: Scenario) => {
    clearTimers();
    stopRecording();
    setScenario(next);
    setMessages(scenarioMessages(next));
    setStreaming(false);
    setDraft('');
    setAttachments([]);
    setPicker(null);
    setAway(false);
  };
  const generate = (messageId: string) => {
    clearTimers();
    activeStream.current = messageId;
    setStreaming(true);
    let progress = 0;
    const tick = () => {
      if (activeStream.current !== messageId) return;
      progress += 3;
      const done = progress >= response.length;
      setMessages((value) =>
        value.map((message) =>
          message.id === messageId
            ? {
                ...message,
                text: response.slice(0, progress),
                state: done ? 'done' : 'streaming',
                rich: done ? 'overview' : undefined,
              }
            : message,
        ),
      );
      if (done) {
        setStreaming(false);
        activeStream.current = '';
      } else timers.current.push(setTimeout(tick, 85));
    };
    timers.current.push(setTimeout(tick, 450));
  };
  const readonly = scenario === 'readonly';
  const send = () => {
    if ((!draft.trim() && !attachments.length) || readonly) return;
    if (streaming) {
      notify('已排队，当前回复结束后发送');
      return;
    }
    const id = `reply-${++sequence.current}`;
    setMessages((value) => [
      ...value,
      { id: `user-${sequence.current}`, role: 'user', text: draft.trim(), files: attachments },
      { id, role: 'assistant', text: '', state: 'streaming' },
    ]);
    setDraft('');
    setAttachments([]);
    setPicker(null);
    setAway(false);
    generate(id);
    input.current?.focus();
  };
  const stop = () => {
    const id = activeStream.current;
    clearTimers();
    setStreaming(false);
    setMessages((value) => value.map((message) => (message.id === id ? { ...message, state: 'stopped' } : message)));
  };
  // Voice input: speech-to-text fills the composer, never sends by itself. Esc cancels.
  const startRecording = () => {
    setRecording(1);
    recordTimer.current = setInterval(() => {
      setRecording((value) => {
        if (value >= 3) {
          stopRecording();
          setDraft((current) => `${current}${current ? ' ' : ''}帮我把本周进度整理成周报`);
          input.current?.focus();
          return 0;
        }
        return value + 1;
      });
    }, 700);
  };
  const mentionItems =
    counterpart.kind === 'room' ? ['陈晨', '周宁', agents[0].name, '卷卷'] : agents.map((agent) => agent.name);
  const suggestionItems = picker === 'mention' ? mentionItems : skills.map((skill) => skill.name);
  const pick = (title: string) => {
    if (picker === 'mention') setDraft((value) => value.replace(/@[^\s]*$/, `@${title} `));
    else setDraft(`/${title} `);
    setPicker(null);
    input.current?.focus();
  };
  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const chosen = Array.from(files)
      .slice(0, 5 - attachments.length)
      .filter((file) => {
        if (file.size > 10 * 1024 * 1024) {
          notify('单个文件不能超过 10 MB');
          return false;
        }
        return true;
      })
      .map((file) => {
        const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        if (url) urls.current.push(url);
        return { name: file.name, size: file.size, url };
      });
    setAttachments((value) => [...value, ...chosen]);
    if (fileInput.current) fileInput.current.value = '';
  };
  const hasComputer = counterpart.kind !== 'room';
  return (
    <div className="chat-page">
      <header className="page-header chat-header">
        {headerLead}
        {counterpart.kind === 'room' ? (
          <span className="file-icon">
            <Hash size={16} />
          </span>
        ) : (
          <PlantAvatar plant={counterpart.agent.plant} size={28} animate={false} />
        )}
        <div className="chat-identity">
          <h1 className="page-header-title">{counterpart.title}</h1>
          <span className="muted small">{counterpart.sub}</span>
        </div>
        <span className="grow" />
        {hasComputer && (
          <IconButton label="电脑" onClick={() => openAgent(counterpart.agent.id, '电脑')}>
            <MonitorPlay size={18} />
          </IconButton>
        )}
        <IconButton
          label="信息"
          onClick={() =>
            openPanel(
              '信息',
              <div className="stack">
                <h3 className="small-title">成员</h3>
                <p>
                  {counterpart.kind === 'room'
                    ? `林杰、陈晨、周宁 · ${agents[0].name}、卷卷`
                    : `你和 ${counterpart.agent.name}`}
                </p>
                <h3 className="small-title">摘要</h3>
                <p className="muted">本周讨论了产品改版进度和导入检查的优先级。</p>
                <h3 className="small-title">共享笔记</h3>
                <TextArea rows={3} aria-label="共享笔记" defaultValue="导入检查先于移动端导航。" />
              </div>,
            )
          }
        >
          <Info size={18} />
        </IconButton>
        <Menu
          items={
            counterpart.kind === 'chat'
              ? menus.chat(counterpart.title, () =>
                  downloadText(`${counterpart.title}.md`, messages.map((item) => item.text).join('\n\n')),
                )
              : counterpart.kind === 'room'
                ? menus.room(selection.slice(5))
                : menus.agent(counterpart.agent)
          }
        />
        {mobile && (
          <IconButton label="通知" onClick={() => navigate('notifications')}>
            <Bell size={18} />
            {needsYou > 0 && <span className="notification-dot" />}
          </IconButton>
        )}
      </header>
      <div className="chat-preview-controls">
        <span className="muted small">体验状态</span>
        <NativeSelect
          label="对话状态"
          value={scenarioOptions.find((item) => item[0] === scenario)![1]}
          options={scenarioOptions.map((item) => item[1])}
          onChange={(label) => loadScenario(scenarioOptions.find((item) => item[1] === label)![0])}
        />
        <Button kind="ghost" onClick={() => loadScenario(scenario)}>
          重置
        </Button>
      </div>
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={() => {
          const element = scroller.current;
          if (element) setAway(element.scrollHeight - element.scrollTop - element.clientHeight > 100);
        }}
      >
        <div className="conversation">
          {!messages.length && (
            <div className="chat-welcome">
              <PlantAvatar plant={counterpart.agent.plant} size={72} animate={false} />
              <h1>
                {counterpart.kind === 'room' ? '和同事、各自的 Agent 一起' : `今天交给${counterpart.agent.name}什么？`}
              </h1>
              <div className="starter-prompts">
                {skills.slice(0, 3).map((skill) => (
                  <Button
                    key={skill.id}
                    onClick={() => {
                      setDraft(`/${skill.name} `);
                      input.current?.focus();
                    }}
                  >
                    <Slash size={13} />
                    {skill.name}
                  </Button>
                ))}
              </div>
              {scenario === 'stream' && (
                <Button
                  kind="primary"
                  onClick={() => {
                    const id = `reply-${++sequence.current}`;
                    setMessages([
                      { id: 'user-stream', role: 'user', text: '看看本周进度' },
                      { id, role: 'assistant', text: '', state: 'streaming' },
                    ]);
                    generate(id);
                  }}
                >
                  播放生成过程
                </Button>
              )}
            </div>
          )}
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              role={message.role}
              text={message.text}
              agent={counterpart.agent}
              streaming={message.state === 'streaming'}
              footer={
                message.state === 'stopped' ? (
                  <div className="row muted small">
                    <Square size={12} />
                    <span>已停止</span>
                    <Button kind="ghost" onClick={() => generate(message.id)}>
                      重新生成
                    </Button>
                  </div>
                ) : undefined
              }
            >
              {message.files?.map((file) => (
                <Attachment
                  key={file.name}
                  {...file}
                  onClick={() =>
                    openPanel(
                      file.name,
                      file.url ? (
                        <img className="attachment-preview" alt={file.name} src={file.url} />
                      ) : (
                        <p>文件已附加 · {(file.size / 1024).toFixed(1)} KB</p>
                      ),
                    )
                  }
                />
              ))}
              {message.rich === 'overview' && (
                <>
                  <RecordsCard records={records.filter((record) => record.status !== '已完成').slice(0, 2)} />
                  <div className="citation-row">
                    <button onClick={() => openDocument('doc-2')}>
                      <FileText size={14} />
                      10 月产品计划
                    </button>
                    <button onClick={() => openPanel('产品计划 / 任务', <RichTable records={records} />)}>
                      <FileText size={14} />
                      产品计划 / 任务
                    </button>
                  </div>
                  <ToolCard initial="done" />
                </>
              )}
              {message.rich === 'tools' && (
                <>
                  <ToolCard initial="done" />
                  <ToolCard initial="failed" />
                  <RunCard running />
                </>
              )}
              {message.rich === 'approval' && (
                <ApprovalCard
                  onResult={(result) => {
                    if (result === 'accepted') {
                      setRecords((value) =>
                        value.map((record) =>
                          ['GH-104', 'GH-102'].includes(record.id) ? { ...record, status: '已完成' } : record,
                        ),
                      );
                      notify('2 条任务已更新');
                    }
                  }}
                />
              )}
              {message.rich === 'requests' && (
                <>
                  <RequestCard kind="login" />
                  <RequestCard kind="takeover" />
                  <RequestCard kind="question" />
                  <RequestCard kind="proposal" />
                </>
              )}
              {message.rich === 'rich' && <RichResults records={records} />}
              {message.rich === 'media' && <MediaResults />}
              {message.rich === 'artifact' && (
                <>
                  <ArtifactCard />
                  <CodeBlock />
                </>
              )}
              {message.rich === 'error' && (
                <ErrorBox
                  onRetry={() => {
                    setMessages((value) =>
                      value.map((item) =>
                        item.id === message.id ? { ...item, rich: undefined, text: '', state: 'streaming' } : item,
                      ),
                    );
                    generate(message.id);
                  }}
                >
                  回复没有完成：连接中断了，已生成的内容已保留。
                </ErrorBox>
              )}
              {message.state === 'streaming' && !message.text && (
                <div className="row muted small">
                  <Spinner />
                  正在查找…
                </div>
              )}
            </MessageBubble>
          ))}
        </div>
      </div>
      {away && (
        <Button
          className="jump-bottom"
          onClick={() => {
            setAway(false);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ArrowDown size={14} />
          最新消息
        </Button>
      )}
      <div className="composer-zone">
        {readonly ? (
          <div className="readonly-banner">
            <LockKeyhole size={15} />
            这个 Agent 已归档，对话只能查看。
            <Button kind="ghost" onClick={() => notify('已恢复 Agent')}>
              恢复
            </Button>
          </div>
        ) : (
          <div
            className="composer"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              addFiles(event.dataTransfer.files);
            }}
          >
            {attachments.length > 0 && (
              <div className="attachment-strip">
                {attachments.map((file, index) => (
                  <div key={`${file.name}-${index}`}>
                    <Attachment {...file} />
                    <IconButton
                      size="sm"
                      label={`移除 ${file.name}`}
                      onClick={() => setAttachments((value) => value.filter((_, itemIndex) => index !== itemIndex))}
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
            {recording > 0 ? (
              <div className="recording" role="status" aria-live="polite">
                <span className="recording-dot" />
                <span className="wave" aria-hidden>
                  {Array.from({ length: 18 }, (_, index) => (
                    <i key={index} style={{ animationDelay: `${index * 60}ms` }} />
                  ))}
                </span>
                <span className="tabular small">0:0{recording}</span>
                <span className="muted small grow">正在听… 说完自动填入，按 Esc 取消</span>
                <Button kind="ghost" onClick={stopRecording}>
                  取消
                </Button>
              </div>
            ) : (
              <textarea
                ref={input}
                aria-label="消息"
                placeholder={`给 ${counterpart.kind === 'room' ? counterpart.title : counterpart.agent.name} 发消息`}
                value={draft}
                rows={2}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft(value);
                  setPicker(
                    /@[^\s]*$/.test(value) ? 'mention' : value.startsWith('/') && !value.includes(' ') ? 'slash' : null,
                  );
                  setPickerIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (picker) {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setPicker(null);
                    }
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      setPickerIndex(
                        (value) =>
                          (value + (event.key === 'ArrowDown' ? 1 : -1) + suggestionItems.length) %
                          suggestionItems.length,
                      );
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      pick(suggestionItems[pickerIndex]);
                    }
                  } else if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
            )}
            {picker && (
              <div className="composer-picker" role="listbox" aria-label={picker === 'mention' ? '点名' : '技能'}>
                {suggestionItems.map((item, index) => (
                  <button
                    key={item}
                    role="option"
                    aria-selected={index === pickerIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(item)}
                  >
                    {picker === 'mention' ? <AtSign size={16} /> : <Slash size={16} />}
                    {item}
                    <span className="muted small">
                      {picker === 'mention'
                        ? agents.some((agent) => agent.name === item)
                          ? 'Agent'
                          : '成员'
                        : skills.find((skill) => skill.name === item)?.kind}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="composer-toolbar">
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.csv,.docx,.xlsx"
                hidden
                onChange={(event) => addFiles(event.target.files)}
              />
              <IconButton
                label="添加附件"
                disabled={attachments.length >= 5}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={18} />
              </IconButton>
              <IconButton
                label="点名"
                onClick={() => {
                  setDraft((value) => `${value}@`);
                  setPicker('mention');
                  input.current?.focus();
                }}
              >
                <AtSign size={17} />
              </IconButton>
              <IconButton
                label="技能"
                onClick={() => {
                  setDraft('/');
                  setPicker('slash');
                  input.current?.focus();
                }}
              >
                <Slash size={16} />
              </IconButton>
              <span className="grow" />
              {counterpart.kind === 'chat' && (
                <Menu
                  label="会话设置"
                  items={[
                    { label: '模型：默认（DeepSeek）', onClick: () => notify('只有工作区配置了多个模型时才出现') },
                    { label: '模型：强（Claude）', onClick: () => notify('本次会话改用强模型') },
                  ]}
                />
              )}
              <IconButton
                label="语音输入"
                aria-pressed={recording > 0}
                onClick={() => (recording ? stopRecording() : startRecording())}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') stopRecording();
                }}
              >
                <Mic size={17} />
              </IconButton>
              {streaming && !draft.trim() ? (
                <Button className="send-button" aria-label="停止生成" onClick={stop}>
                  <Square size={15} />
                </Button>
              ) : (
                <Button
                  kind="primary"
                  className="send-button"
                  aria-label={streaming ? '排队发送' : '发送消息'}
                  disabled={!draft.trim() && !attachments.length}
                  onClick={send}
                >
                  <ArrowUp size={18} />
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="composer-caption">
          <span>内容可能有误，请核对重要信息。</span>
          <span>Enter 发送 · Shift Enter 换行</span>
        </div>
      </div>
    </div>
  );
}

export function MessageBubble({
  role = 'assistant',
  text,
  agent = agents[0],
  streaming = false,
  children,
  footer,
}: {
  role?: 'user' | 'assistant';
  text: string;
  agent?: AgentItem;
  streaming?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const { notify, navigate } = useDesign();
  const [vote, setVote] = useState('');
  const [speaking, setSpeaking] = useState(false);
  // Read aloud: the TTS provider when configured, the browser's own voice otherwise.
  const readAloud = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth?.cancel();
      setSpeaking(false);
      return;
    }
    if (!synth) {
      notify('这个浏览器不支持朗读');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utterance);
  };
  return (
    <article className={`message ${role}`}>
      {role === 'assistant' && (
        <div className="message-avatar">
          <PlantAvatar plant={agent.plant} size={avatar.md} state={streaming ? 'speaking' : 'idle'} />
        </div>
      )}
      <div className="message-body">
        {role === 'assistant' && (
          <header className="message-header">
            <strong>{agent.name}</strong>
            <span>10:30</span>
          </header>
        )}
        {text && <p className={`message-text ${streaming ? 'streaming-text' : ''}`}>{text}</p>}
        {children}
        {footer}
        {role === 'assistant' && !streaming && !footer && text && (
          <div className="message-actions">
            <IconButton
              label="复制"
              size="sm"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(text)
                  .then(() => notify('已复制'))
                  .catch(() => notify('请选中内容复制'));
              }}
            >
              <Copy size={14} />
            </IconButton>
            <IconButton
              label="有帮助"
              size="sm"
              aria-pressed={vote === 'up'}
              onClick={() => setVote(vote === 'up' ? '' : 'up')}
            >
              <ThumbsUp size={14} />
            </IconButton>
            <IconButton
              label="没帮助"
              size="sm"
              aria-pressed={vote === 'down'}
              onClick={() => setVote(vote === 'down' ? '' : 'down')}
            >
              <ThumbsDown size={14} />
            </IconButton>
            <IconButton label={speaking ? '停止朗读' : '朗读'} size="sm" aria-pressed={speaking} onClick={readAloud}>
              <Volume2 size={14} />
            </IconButton>
            <IconButton label="从这里新开会话" size="sm" onClick={() => navigate('chat', 'new')}>
              <Split size={14} />
            </IconButton>
          </div>
        )}
      </div>
    </article>
  );
}

/** Process: one folded line per tool call; the details are there when asked for. */
export function ToolCard({ initial = 'done' }: { initial?: 'queued' | 'running' | 'done' | 'failed' }) {
  const [state, setState] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <ChatCard
      expandable
      defaultOpen={state === 'failed'}
      title="查询 产品计划 / 任务"
      meta={state === 'done' ? '8 条记录' : undefined}
      status={{ queued: '排队中', running: '运行中', done: '已完成', failed: '失败' }[state]}
      tone={state === 'done' ? 'neutral' : undefined}
    >
      {state === 'failed' ? (
        <ErrorBox
          onRetry={() => {
            setState('running');
            timer.current = setTimeout(() => setState('done'), 1000);
          }}
        >
          连接暂时中断。
        </ErrorBox>
      ) : state === 'running' || state === 'queued' ? (
        <Skeleton lines={2} />
      ) : (
        <p className="chat-card-text">读取了名称、状态、负责人和截止日期。</p>
      )}
    </ChatCard>
  );
}
/** Process: a run with several steps. */
export function RunCard({ running = false }: { running?: boolean }) {
  return (
    <ChatCard
      icon={<Activity size={16} />}
      title="生成周报"
      meta="3 步"
      status={running ? '运行中' : '已完成'}
      tone={running ? undefined : 'neutral'}
    >
      <Steps running={running} />
    </ChatCard>
  );
}
/** Result: records the answer is about. Each row opens the record. */
export function RecordsCard({ records }: { records: RecordItem[] }) {
  const { navigate } = useDesign();
  return (
    <ChatCard
      icon={<Table2 size={16} />}
      title="产品计划 / 任务"
      meta={`${records.length} 条`}
      footer={
        <Button kind="ghost" onClick={() => navigate('tables')}>
          打开表格
        </Button>
      }
    >
      <div className="record-rows">
        {records.map((record) => (
          <EntityCard record={record} key={record.id} />
        ))}
      </div>
    </ChatCard>
  );
}
export function EntityCard({ record }: { record: RecordItem }) {
  const { openRecord } = useDesign();
  return (
    <button className="entity-row" onClick={() => openRecord(record)}>
      <span className="grow">
        <span className="entity-row-title">{record.title}</span>
        <span className="muted small">
          {record.owner} · {record.date.slice(5).replace('-', ' 月 ')} 日截止
        </span>
      </span>
      <StatusBadge status={record.status} />
      <ChevronRight size={15} className="muted" />
    </button>
  );
}
export function Attachment({
  name,
  size,
  url,
  onClick,
}: {
  name: string;
  size: number;
  url?: string;
  onClick?: () => void;
}) {
  return (
    <button className="attachment" onClick={onClick}>
      {url ? <img src={url} alt="" /> : <FileText size={22} />}
      <span>
        <strong>{name}</strong>
        <span className="muted small">
          {size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`}
        </span>
      </span>
    </button>
  );
}
/** Result: a table excerpt with a way back to the full table. */
export function RichTable({ records }: { records: RecordItem[] }) {
  const { openRecord, notify, navigate } = useDesign();
  return (
    <ChatCard
      icon={<Table2 size={16} />}
      title="产品计划 / 任务"
      meta="前 3 条"
      footer={
        <>
          <Button kind="ghost" onClick={() => navigate('tables')}>
            打开表格
          </Button>
          <Button kind="ghost" onClick={() => notify('已导出 CSV')}>
            <Download size={14} />
            导出 CSV
          </Button>
        </>
      }
    >
      <div className="rich-table-scroll">
        <table className="rich-table">
          <thead>
            <tr>
              <th>任务</th>
              <th>状态</th>
              <th>负责人</th>
            </tr>
          </thead>
          <tbody>
            {records.slice(0, 3).map((record) => (
              <tr key={record.id}>
                <td>
                  <button onClick={() => openRecord(record)}>{record.title}</button>
                </td>
                <td>{record.status}</td>
                <td>{record.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChatCard>
  );
}
export function RichResults({ records }: { records: RecordItem[] }) {
  return (
    <div className="card-stack">
      <div className="stat-grid">
        <div>
          <span className="muted small">全部任务</span>
          <strong className="tabular">{records.length}</strong>
        </div>
        <div>
          <span className="muted small">已完成</span>
          <strong className="tabular">{records.filter((record) => record.status === '已完成').length}</strong>
        </div>
        <div>
          <span className="muted small">进行中</span>
          <strong className="tabular">{records.filter((record) => record.status === '进行中').length}</strong>
        </div>
      </div>
      <RichTable records={records} />
      <MiniChart />
    </div>
  );
}
/** Results from the image, video and TTS providers. */
export function MediaResults() {
  const { notify, navigate } = useDesign();
  const [playing, setPlaying] = useState(false);
  return (
    <div className="card-stack">
      <ChatCard
        icon={<ImageIcon size={16} />}
        title="封面图"
        meta="1536×1024"
        footer={
          <Button kind="ghost" aria-label="下载图片" onClick={() => notify('已下载 cover.png')}>
            <Download size={14} />
            下载
          </Button>
        }
      >
        <div className="media-image" role="img" aria-label="生成的封面图：绿色温室与日出">
          <PlantAvatar plant="sunflower" size={88} animate={false} />
        </div>
      </ChatCard>
      <ChatCard
        icon={<Film size={16} />}
        title="开场视频"
        meta="5 秒"
        status="生成中"
        footer={
          <Button kind="ghost" onClick={() => navigate('runs')}>
            在运行中查看
          </Button>
        }
      >
        <div className="media-video">
          <Spinner />
          <span className="small muted">约 1 分钟</span>
        </div>
      </ChatCard>
      <ChatCard icon={<AudioLines size={16} />} title="开场白" meta="0:18">
        <div className="audio-player">
          <IconButton
            label={playing ? '暂停' : '播放开场白'}
            aria-pressed={playing}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? <Square size={14} /> : <Play size={14} />}
          </IconButton>
          <span className="audio-track">
            <span style={{ width: playing ? '40%' : '0%' }} />
          </span>
          <span className="muted small tabular">{playing ? '0:07' : '0:00'}</span>
        </div>
      </ChatCard>
    </div>
  );
}
/** Result: a file the Agent produced. */
export function ArtifactCard() {
  const { openPanel, notify } = useDesign();
  const [preview, setPreview] = useState(false);
  const content =
    '# 产品改版周报\n\n本周完成 3 条任务，2 条进行中。\n\n## 下周安排\n\n- 检查数据导入错误\n- 确认移动端导航\n';
  return (
    <ChatCard
      icon={<FileText size={16} />}
      title="产品改版周报"
      meta="Markdown · 2 KB"
      footer={
        <>
          <Button
            kind="ghost"
            onClick={() =>
              openPanel(
                '产品改版周报',
                <div className="stack">
                  <h3>产品改版周报</h3>
                  <p>本周完成 3 条任务，2 条进行中。</p>
                  <h3>下周安排</h3>
                  <ul>
                    <li>检查数据导入错误</li>
                    <li>确认移动端导航</li>
                  </ul>
                </div>,
              )
            }
          >
            <ExternalLink size={14} />
            打开
          </Button>
          <Button
            kind="ghost"
            aria-label="下载周报"
            onClick={() => {
              downloadText('产品改版周报.md', content, 'text/markdown;charset=utf-8');
              notify('已下载 Markdown');
            }}
          >
            <Download size={14} />
            下载
          </Button>
          <Button kind="ghost" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            <Code size={14} />
            网页预览
          </Button>
        </>
      }
    >
      <div className="artifact-preview">
        <h3>本周进度</h3>
        <p>完成 3 条任务，2 条进行中。</p>
      </div>
      {preview && (
        <iframe
          title="周报网页预览"
          sandbox="allow-scripts"
          srcDoc={`<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>body{font:15px system-ui;padding:24px;color:#235d4d;background:#f2f5f2}button{padding:10px 18px;border:1px solid #235d4d;border-radius:8px;background:white;color:inherit}</style><h2>产品改版周报</h2><p>本周完成 3 条任务。</p><button onclick='this.textContent = this.textContent === &quot;展开下周计划&quot; ? &quot;检查数据导入 · 确认移动端导航&quot; : &quot;展开下周计划&quot;'>展开下周计划</button></html>`}
        />
      )}
    </ChatCard>
  );
}
export function CodeBlock() {
  const { notify } = useDesign();
  const code = 'const progress = {\n  completed: 3,\n  inProgress: 2,\n};';
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>TypeScript</span>
        <IconButton
          label="复制代码"
          size="sm"
          onClick={() => {
            navigator.clipboard
              ?.writeText(code)
              .then(() => notify('已复制代码'))
              .catch(() => notify('请选中代码复制'));
          }}
        >
          <Copy size={14} />
        </IconButton>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
