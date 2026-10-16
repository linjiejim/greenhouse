/**
 * 文件 (AGNT-19): the computer's home folder. A folder opens in place and a file downloads;
 * uploads land in the folder shown and never overwrite (a taken name becomes "name (1).ext");
 * deleting asks first. Paths are relative to the home, and the server refuses any that leave it.
 */

import { Fragment, useRef, useState, type ChangeEvent } from 'react';
import { ChevronRight, File as FileIcon, Folder, Upload } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Menu,
  Skeleton,
  useContextMenu,
  type MenuEntry,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { ComputerFile } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../app/notify';
import { useMe } from '../app/session';
import { useComputerFileActions, useComputerFiles } from '../data/agents';
import { formatSize } from '../data/files';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { saveBlob } from '../lib/save';
import { relativeTime } from '../lib/time';

const LIST_MAX = 500;
const inside = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

function FileRow({
  item,
  meta,
  label,
  menu,
  onOpen,
}: {
  item: ComputerFile;
  meta: string;
  label: string;
  menu: MenuEntry[];
  onOpen: () => void;
}) {
  const context = useContextMenu(menu, label);
  const Icon = item.type === 'dir' ? Folder : FileIcon;
  return (
    <li className="app-list-row is-static" {...context.handlers}>
      <button type="button" className="app-link-button app-file-open" onClick={onOpen}>
        <Icon size={icon.md} strokeWidth={icon.stroke} className="app-file-icon" aria-hidden />
        <span className="app-list-main">
          <span className="app-list-title">{item.name}</span>
          <span className="app-list-meta">{meta}</span>
        </span>
      </button>
      <Menu label={label} items={menu} />
      {context.menu}
    </li>
  );
}

export function ComputerFiles({ agentId }: { agentId: string }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const [path, setPath] = useState('');
  const folder = useComputerFiles(agentId, path);
  const actions = useComputerFileActions(agentId);
  const [deleting, setDeleting] = useState<ComputerFile | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const parts = path ? path.split('/') : [];

  const download = (item: ComputerFile) =>
    api.agents
      .file(agentId, inside(path, item.name))
      .then(({ blob, filename }) => saveBlob(blob, filename || item.name))
      .catch((error: unknown) =>
        notify(
          error instanceof ApiClientError && error.code === 'too_large'
            ? t('computer.downloadTooLarge')
            : errorText(error, t),
        ),
      );

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    for (const file of files) {
      try {
        const saved = await actions.upload.mutateAsync({ folder: path, file });
        notify(t('computer.uploaded', { name: saved.name }));
      } catch (error) {
        notify(errorText(error, t));
      }
    }
  };

  const items = folder.data?.items ?? [];
  return (
    <div className="app-files">
      <div className="app-screen-bar">
        <nav className="app-crumbs" aria-label={t('computer.path')}>
          <button
            type="button"
            className="app-link-button"
            aria-current={parts.length ? undefined : 'location'}
            onClick={() => setPath('')}
          >
            {t('computer.home')}
          </button>
          {parts.map((part, index) => (
            <Fragment key={parts.slice(0, index + 1).join('/')}>
              <ChevronRight size={icon.sm} aria-hidden className="app-crumb-sep" />
              <button
                type="button"
                className="app-link-button"
                aria-current={index === parts.length - 1 ? 'location' : undefined}
                onClick={() => setPath(parts.slice(0, index + 1).join('/'))}
              >
                {part}
              </button>
            </Fragment>
          ))}
        </nav>
        <span className="app-page-header-spacer" />
        <Button size="sm" loading={actions.upload.isPending} onClick={() => picker.current?.click()}>
          <Upload size={icon.sm} />
          {t('computer.upload')}
        </Button>
        <input ref={picker} type="file" multiple hidden onChange={(event) => void upload(event)} />
      </div>
      {folder.isPending ? (
        <Skeleton lines={4} />
      ) : folder.isError ? (
        <ErrorBox onRetry={() => void folder.refetch()}>{errorText(folder.error, t)}</ErrorBox>
      ) : !items.length ? (
        <Empty title={t('computer.emptyFolder')} />
      ) : (
        <ul className="app-list">
          {items.map((item) => {
            const target = inside(path, item.name);
            const when = relativeTime(item.modified_at, { locale, timeZone: me.timezone });
            const open = () => (item.type === 'dir' ? setPath(target) : void download(item));
            return (
              <FileRow
                key={item.name}
                item={item}
                meta={item.type === 'dir' ? when : `${formatSize(item.size, locale)} · ${when}`}
                label={t('row.actionsFor', { name: item.name })}
                onOpen={open}
                menu={[
                  { label: item.type === 'dir' ? t('computer.open') : t('computer.download'), onClick: open },
                  '-',
                  { label: t('row.delete'), danger: true, onClick: () => setDeleting(item) },
                ]}
              />
            );
          })}
        </ul>
      )}
      {folder.data?.truncated && <p className="app-muted">{t('computer.truncated', { count: LIST_MAX })}</p>}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('computer.deleteTitle', { name: deleting.name })}
          confirmLabel={t('row.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = inside(path, deleting.name);
            setDeleting(null);
            actions.remove.mutate(target, { onError: (error) => notify(errorText(error, t)) });
          }}
        >
          {t('computer.deleteBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}
