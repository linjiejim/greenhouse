import { ExtensionPanels } from '../../extensions/host';
/**
 * An Agent's one home (AGNT-05): profile, abilities, memory, schedules, computer and mailbox. The
 * header says who it is and offers "message"; its "⋯" archives or restores.
 */

import { useState } from 'react';
import { Archive, MessageSquare, RotateCcw } from 'lucide-react';
import { Button, ConfirmDialog, Empty, ErrorBox, Skeleton, Tabs, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useAgent, useArchiveAgent, useRestoreAgent } from '../../data/agents';
import { useCreateConversation } from '../../data/conversations';
import { useMailbox } from '../../data/mail';
import type { MessageKey } from '../../i18n/zh';
import { useI18n } from '../../lib/i18n';
import { navigate, type AgentTab } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { Page, PageHeader } from '../../shell/Page';
import { AbilitiesTab } from './AbilitiesTab';
import { ActivityTab } from './ActivityTab';
import { PublishTab } from './PublishTab';
import { ComputerTab } from './ComputerTab';
import { MailboxTab } from './MailboxTab';
import { MemoryTab } from './MemoryTab';
import { ProfileTab } from './ProfileTab';
import { SchedulesTab } from './SchedulesTab';

const TAB_LABEL: Record<AgentTab, MessageKey> = {
  profile: 'agents.tabProfile',
  abilities: 'agents.tabAbilities',
  memory: 'agents.tabMemory',
  schedules: 'agents.tabSchedules',
  computer: 'agents.tabComputer',
  mailbox: 'mail.tab',
  publish: 'agents.tabPublish',
  activity: 'agents.tabActivity',
};

export function AgentPage({ id, tab }: { id: string; tab: AgentTab }) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const agent = useAgent(id);
  const archive = useArchiveAgent();
  const restore = useRestoreAgent();
  const createConversation = useCreateConversation();
  const [archiving, setArchiving] = useState(false);
  // The tab shows only while the Agent has a mailbox (a receiving mail service and a domain).
  const mailbox = useMailbox(agent.data && !agent.data.archived_at ? agent.data.id : undefined);

  if (agent.isPending)
    return (
      <Page width="form" header={<PageHeader title="" />}>
        <Skeleton lines={6} />
      </Page>
    );
  if (agent.isError || !agent.data) {
    const missing = agent.error instanceof ApiClientError && agent.error.status === 404;
    return (
      <Page width="form" header={<PageHeader title={missing ? t('common.notFound') : t('common.error')} />}>
        {missing ? (
          <Empty title={t('common.notFound')} />
        ) : (
          <ErrorBox onRetry={() => void agent.refetch()}>{t('common.error')}</ErrorBox>
        )}
      </Page>
    );
  }

  const data = agent.data;
  const archived = !!data.archived_at;
  const computers = me.modules.computer && me.capabilities.sandbox;
  const tabs: AgentTab[] = [
    'profile',
    'abilities',
    'memory',
    'schedules',
    ...(computers ? (['computer'] as const) : []),
    ...(mailbox.data?.available ? (['mailbox'] as const) : []),
    ...(data.is_main ? [] : (['publish'] as const)),
    'activity',
  ];
  const current = tabs.includes(tab) ? tab : 'profile';
  const routeId = data.is_main ? 'main' : data.id;

  const openThread = () => {
    if (data.is_main) return navigate('#/c/main');
    if (data.conversation_id) return navigate({ page: 'conversation', id: data.conversation_id });
    createConversation.mutate(
      { kind: 'direct', agent_id: data.id },
      { onSuccess: (conversation) => navigate({ page: 'conversation', id: conversation.id }) },
    );
  };

  const menu: MenuEntry[] = data.is_main
    ? []
    : archived
      ? [
          {
            label: t('agents.restore'),
            icon: <RotateCcw size={icon.md} />,
            onClick: () =>
              restore.mutate(data.id, { onSuccess: () => notify(t('agents.restored', { name: data.name })) }),
          },
        ]
      : [{ label: t('row.archive'), icon: <Archive size={icon.md} />, onClick: () => setArchiving(true) }];

  return (
    <Page
      width="form"
      header={
        <PageHeader
          leading={<AgentAvatar agent={data} size={28} />}
          title={
            <span className="app-title-stack">
              <span className="app-title-name">{data.name}</span>
              <span className="app-title-status">{data.role || (data.is_main ? t('agents.mainRole') : '')}</span>
            </span>
          }
          primary={
            archived ? undefined : (
              <Button kind="primary" onClick={openThread} loading={createConversation.isPending}>
                <MessageSquare size={icon.md} />
                {t('agents.message')}
              </Button>
            )
          }
          menu={menu}
        />
      }
    >
      {archived && <div className="app-banner">{t('agents.archivedNotice')}</div>}
      <Tabs
        label={data.name}
        items={tabs.map((item) => t(TAB_LABEL[item]))}
        value={t(TAB_LABEL[current])}
        onChange={(label) => {
          const next = tabs.find((item) => t(TAB_LABEL[item]) === label) ?? 'profile';
          navigate({ page: 'agent', id: routeId, tab: next }, { replace: true });
        }}
      />
      {current === 'profile' && <ProfileTab agent={data} />}
      {current === 'abilities' && <AbilitiesTab agent={data} />}
      {current === 'memory' && <MemoryTab agentId={data.id} />}
      {current === 'schedules' && <SchedulesTab agentId={data.id} />}
      {current === 'computer' && <ComputerTab agentId={data.id} />}
      {current === 'mailbox' && <MailboxTab agentId={data.id} name={data.name} />}
      {current === 'publish' && <PublishTab agent={data} />}
      {current === 'activity' && <ActivityTab agentId={data.id} />}
      <ExtensionPanels entity="agent" id={data.id} />
      {archiving && (
        <ConfirmDialog
          title={t('agents.archiveTitle', { name: data.name })}
          confirmLabel={t('row.archive')}
          onCancel={() => setArchiving(false)}
          onConfirm={() => {
            setArchiving(false);
            archive.mutate(data.id, {
              onSuccess: () => {
                notify(t('chat.archived', { name: data.name }), {
                  label: t('row.undo'),
                  onClick: () => restore.mutate(data.id),
                });
                void agent.refetch();
              },
            });
          }}
        >
          {t('agents.archiveBody')}
        </ConfirmDialog>
      )}
    </Page>
  );
}
