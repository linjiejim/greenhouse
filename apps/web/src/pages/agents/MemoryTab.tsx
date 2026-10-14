/**
 * 记忆 (AGNT-08): what this Agent remembers about the member and its work. Only titles reach
 * the prompt; the detail is read when needed. Add, edit, pin, or forget (with a confirmation).
 */

import { useState, type FormEvent } from 'react';
import { Pin, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  Input,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  Switch,
  TextArea,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { MEMORY_CATEGORIES, type AgentMemory } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useMemories, useMemoryActions } from '../../data/agents';
import type { MessageKey } from '../../i18n/zh';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

type Category = (typeof MEMORY_CATEGORIES)[number];

const CATEGORY_LABEL: Record<Category, MessageKey> = {
  fact: 'memory.fact',
  preference: 'memory.preference',
  person: 'memory.person',
  project: 'memory.project',
  procedure: 'memory.procedure',
  log: 'memory.log',
};

function MemoryForm({
  agentId,
  memory,
  onClose,
  onForget,
}: {
  agentId: string;
  memory: AgentMemory | null;
  onClose: () => void;
  onForget: (memory: AgentMemory) => void;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const { remember, edit } = useMemoryActions(agentId);
  const [title, setTitle] = useState(memory?.title ?? '');
  const [content, setContent] = useState(memory?.content ?? '');
  const [category, setCategory] = useState<Category>((memory?.category as Category) ?? 'fact');
  const [pinned, setPinned] = useState(memory?.pinned ?? false);
  const [error, setError] = useState('');
  const formId = `memory-${memory?.id ?? 'new'}`;
  const pending = remember.isPending || edit.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return setError(t('request.required', { name: t('memory.title') }));
    const input = { title: title.trim(), content, category, pinned };
    const done = { onSuccess: () => onClose(), onError: () => notify(t('common.error')) };
    if (memory) edit.mutate({ id: memory.id, input }, done);
    else remember.mutate(input, done);
  };

  return (
    <Overlay variant="dialog" wide title={memory ? t('memory.edit') : t('memory.add')} onClose={onClose}>
      <form id={formId} className="app-form" onSubmit={submit}>
        <Field label={t('memory.title')} required error={error || undefined}>
          <Input
            value={title}
            maxLength={120}
            autoFocus
            onChange={(event) => {
              setTitle(event.target.value);
              setError('');
            }}
          />
        </Field>
        <Field label={t('memory.content')}>
          <TextArea
            value={content}
            maxLength={4000}
            maxRows={10}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        <Field label={t('memory.category')}>
          <Select
            label={t('memory.category')}
            value={category}
            options={MEMORY_CATEGORIES.map((value) => ({ value, label: t(CATEGORY_LABEL[value]) }))}
            onChange={(value) => setCategory(value as Category)}
          />
        </Field>
        <div className="app-setting-row">
          <div className="app-setting-text">
            <strong>{t('memory.pinned')}</strong>
            <span>{t('memory.pinnedHint')}</span>
          </div>
          <Switch label={t('memory.pinned')} checked={pinned} onChange={setPinned} />
        </div>
      </form>
      <OverlayActions>
        {memory && (
          <Button kind="danger" className="app-actions-start" onClick={() => onForget(memory)}>
            {t('memory.forget')}
          </Button>
        )}
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form={formId} loading={pending}>
          {t('common.save')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

export function MemoryTab({ agentId }: { agentId: string }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const memories = useMemories(agentId);
  const { forget } = useMemoryActions(agentId);
  const [editing, setEditing] = useState<AgentMemory | 'new' | null>(null);
  const [forgetting, setForgetting] = useState<AgentMemory | null>(null);
  const active = memories.items.filter((memory) => memory.status === 'active');
  const notes = active.filter((memory) => memory.category !== 'log');
  const logs = active.filter((memory) => memory.category === 'log');

  return (
    <section className="app-section" aria-label={t('agents.tabMemory')}>
      <div className="app-section-heading">
        <h2 className="app-section-title">{t('memory.count', { count: active.length })}</h2>
        <Button onClick={() => setEditing('new')}>
          <Plus size={icon.md} />
          {t('memory.add')}
        </Button>
      </div>
      {memories.isPending ? (
        <Skeleton lines={4} />
      ) : memories.isError ? (
        <ErrorBox onRetry={() => void memories.refetch()}>{t('common.error')}</ErrorBox>
      ) : !active.length ? (
        <Empty title={t('memory.none')} />
      ) : (
        <>
          {['notes', 'logs'].map((section) => (
            <div key={section}>
              {section === 'logs' && logs.length > 0 && <h3 className="app-section-title">{t('memory.log')}</h3>}
              <ul className="app-list">
                {(section === 'notes' ? notes : logs).map((memory) => (
                  <li key={memory.id}>
                    <button type="button" className="app-list-row" onClick={() => setEditing(memory)}>
                      {memory.pinned && (
                        <Pin size={icon.sm} className="app-row-muted" aria-label={t('memory.pinned')} />
                      )}
                      <span className="app-list-main">
                        <span className="app-list-title">{memory.title}</span>
                        {memory.content && <span className="app-list-meta">{memory.content}</span>}
                      </span>
                      <Badge>{t(CATEGORY_LABEL[memory.category as Category] ?? 'memory.fact')}</Badge>
                      <time className="app-list-time" dateTime={memory.updated_at}>
                        {relativeTime(memory.updated_at, { locale, timeZone: me.timezone })}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      {editing && (
        <MemoryForm
          agentId={agentId}
          memory={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onForget={(memory) => {
            setEditing(null);
            setForgetting(memory);
          }}
        />
      )}
      {forgetting && (
        <ConfirmDialog
          danger
          title={t('memory.forgetTitle', { title: forgetting.title })}
          confirmLabel={t('memory.forget')}
          onCancel={() => setForgetting(null)}
          onConfirm={() => {
            forget.mutate(forgetting.id);
            setForgetting(null);
          }}
        >
          {t('memory.forgetBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
