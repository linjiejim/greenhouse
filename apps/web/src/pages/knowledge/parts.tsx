/** Small pieces the knowledge pages share: icons, the path above a page, upload rows. */

import { Fragment } from 'react';
import {
  ChevronRight,
  File as FileIcon,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  NotebookText,
  RotateCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { IconButton, Spinner } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeItem, KnowledgeScope, PathEntry } from '@greenhouse/contract';
import { formatSize } from '../../data/files';
import { usePeople } from '../../data/people';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { fileKind } from './helpers';
import type { Upload } from './uploads';

const FILE_ICONS: Record<ReturnType<typeof fileKind>, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  text: FileText,
  audio: FileAudio,
  video: FileVideo,
  other: FileIcon,
};

/** A row's icon: a folder (an Agent's own shows the Agent), a doc, or a file by its kind. */
export function ItemIcon({
  item,
  size = icon.md,
}: {
  item: Pick<KnowledgeItem, 'type' | 'agent_id' | 'content_type' | 'is_template'>;
  size?: number;
}) {
  const { agentById } = usePeople();
  if (item.type === 'folder' && item.agent_id) {
    const agent = agentById.get(item.agent_id);
    if (agent) return <AgentAvatar agent={agent} size={size + 4} />;
  }
  const Icon =
    item.type === 'folder'
      ? Folder
      : item.type === 'doc'
        ? item.is_template
          ? NotebookText
          : FileText
        : FILE_ICONS[fileKind(item.content_type)];
  return <Icon size={size} strokeWidth={icon.stroke} aria-hidden />;
}

/** The space's name, as the root of a path. */
export function useSpaceName() {
  const { t } = useI18n();
  return (scope: KnowledgeScope) =>
    scope === 'team' ? t('knowledge.team') : scope === 'personal' ? t('knowledge.personal') : t('knowledge.shared');
}

/** Where a folder or doc lives: the space, then each folder above it, all links. */
export function Crumbs({
  scope,
  path,
  current,
}: {
  scope: KnowledgeScope;
  path: readonly PathEntry[];
  /** The page's own name, last and not a link. */
  current?: string;
}) {
  const { t } = useI18n();
  const spaceName = useSpaceName();
  return (
    <nav className="app-crumbs app-knowledge-crumbs" aria-label={t('knowledge.path')}>
      <a href={href({ page: 'knowledge', space: scope })}>{spaceName(scope)}</a>
      {path.map((entry) => (
        <Fragment key={entry.id}>
          <ChevronRight size={icon.sm} className="app-crumb-sep" aria-hidden />
          <a href={href({ page: 'folder', id: entry.id })}>{entry.name}</a>
        </Fragment>
      ))}
      {current !== undefined && (
        <>
          <ChevronRight size={icon.sm} className="app-crumb-sep" aria-hidden />
          <span aria-current="location">{current}</span>
        </>
      )}
    </nav>
  );
}

/** Files on their way in: a spinner while uploading, the reason and 重试 when one failed. */
export function UploadList({
  items,
  onRetry,
  onDismiss,
}: {
  items: readonly Upload[];
  onRetry: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  const shown = items.filter((item) => item.status !== 'done');
  if (!shown.length) return null;
  return (
    <ul className="app-uploads" aria-label={t('knowledge.uploads')}>
      {shown.map((item) => (
        <li key={item.key} className={item.status === 'failed' ? 'is-failed' : undefined}>
          {item.status === 'uploading' ? (
            <Spinner size={icon.sm} />
          ) : (
            <FileIcon size={icon.sm} strokeWidth={icon.stroke} aria-hidden />
          )}
          <span className="app-uploads-name">{item.file.name}</span>
          <span className="app-uploads-meta">
            {item.status === 'failed' ? item.error : formatSize(item.file.size, locale)}
          </span>
          {item.status === 'failed' && (
            <>
              <IconButton
                size="sm"
                label={t('knowledge.retryUpload', { name: item.file.name })}
                onClick={() => onRetry(item.key)}
              >
                <RotateCw size={icon.sm} strokeWidth={icon.stroke} />
              </IconButton>
              <IconButton
                size="sm"
                label={t('knowledge.dismissUpload', { name: item.file.name })}
                onClick={() => onDismiss(item.key)}
              >
                <X size={icon.sm} strokeWidth={icon.stroke} />
              </IconButton>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
