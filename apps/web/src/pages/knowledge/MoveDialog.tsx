/**
 * 移动到… (KNOW-01): pick a folder, or the root of a space, for a folder, doc or file. Only places
 * the move can go are offered: the team space for team items; for my own items my space or the
 * team space (moving there is for good); inside someone else's space only the folders they shared.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, House, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ErrorBox, Overlay, OverlayActions, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeItem, KnowledgeScope, KnowledgeSpace } from '@greenhouse/contract';
import { useMe } from '../../app/session';
import { useNotify } from '../../app/notify';
import { refreshTree, useFolder, useKnowledgeRoots } from '../../data/knowledge';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

/** Where an item may go: a folder, or a space root (`folder: null`). */
type Spot = { folder: string | null; space: KnowledgeSpace; name: string };
const spotKey = (spot: Pick<Spot, 'folder' | 'space'>) => spot.folder ?? `root:${spot.space}`;

/** 显示更多 in the picker: the next page of a folder or a space root. */
function PickerMore({ depth, loading, onMore }: { depth: number; loading: boolean; onMore: () => void }) {
  const { t } = useI18n();
  return (
    <div className="app-picker-row" style={{ paddingLeft: `calc(${depth} * var(--gh-space-4))` }}>
      <span className="app-picker-toggle" aria-hidden />
      <Button kind="ghost" size="sm" loading={loading} onClick={onMore}>
        {t('knowledge.showMore')}
      </Button>
    </div>
  );
}

function Branch({
  id,
  name,
  depth,
  moving,
  ownerId,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  depth: number;
  /** The folder being moved: neither it nor anything below it is a place to go. */
  moving: string | null;
  ownerId: string | null;
  selected: string;
  onSelect: (spot: Spot) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const folder = useFolder(id, open);
  const children = (folder.data?.children ?? []).filter(
    (child) => child.type === 'folder' && child.id !== moving && !child.archived_at && child.access !== 'viewer',
  );
  const space = folder.data?.space ?? (ownerId ? 'personal' : 'team');
  return (
    <>
      <div className="app-picker-row" style={{ paddingLeft: `calc(${depth} * var(--gh-space-4))` }}>
        <button
          type="button"
          className="app-picker-toggle"
          aria-label={open ? t('knowledge.collapse', { name }) : t('knowledge.expand', { name })}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={icon.sm} /> : <ChevronRight size={icon.sm} />}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={selected === id}
          className={cx('app-picker-choice', selected === id && 'is-selected')}
          onClick={() => onSelect({ folder: id, space, name })}
        >
          <Folder size={icon.md} strokeWidth={icon.stroke} aria-hidden />
          <span>{name}</span>
        </button>
      </div>
      {open && folder.isPending && <p className="app-muted app-picker-note">{t('common.loading')}</p>}
      {open &&
        children.map((child) => (
          <Branch
            key={child.id}
            id={child.id}
            name={child.name}
            depth={depth + 1}
            moving={moving}
            ownerId={ownerId}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      {open && folder.hasNextPage && (
        <PickerMore depth={depth + 1} loading={folder.isFetchingNextPage} onMore={() => void folder.fetchNextPage()} />
      )}
    </>
  );
}

function Root({
  scope,
  label,
  rootChoice,
  moving,
  ownerId,
  selected,
  onSelect,
}: {
  scope: KnowledgeScope;
  label: string;
  /** The root itself is a place to go (not for someone else's space). */
  rootChoice: boolean;
  moving: string | null;
  ownerId: string | null;
  selected: string;
  onSelect: (spot: Spot) => void;
}) {
  const { t } = useI18n();
  const roots = useKnowledgeRoots(scope);
  const folders = roots.items.filter(
    (item) =>
      item.type === 'folder' &&
      item.id !== moving &&
      item.access !== 'viewer' &&
      (scope !== 'shared' || item.owner_id === ownerId),
  );
  const space: KnowledgeSpace = scope === 'team' ? 'team' : 'personal';
  return (
    <>
      {rootChoice ? (
        <div className="app-picker-row">
          <span className="app-picker-toggle" aria-hidden />
          <button
            type="button"
            role="radio"
            aria-checked={selected === `root:${space}`}
            className={cx('app-picker-choice', selected === `root:${space}` && 'is-selected')}
            onClick={() => onSelect({ folder: null, space, name: label })}
          >
            {scope === 'team' ? <Users size={icon.md} aria-hidden /> : <House size={icon.md} aria-hidden />}
            <span>{label}</span>
          </button>
        </div>
      ) : (
        <p className="app-picker-heading">{label}</p>
      )}
      {roots.isPending && <Skeleton lines={2} />}
      {roots.isError && <ErrorBox onRetry={() => void roots.refetch()}>{errorText(roots.error, t)}</ErrorBox>}
      {folders.map((folder) => (
        <Branch
          key={folder.id}
          id={folder.id}
          name={folder.name}
          depth={1}
          moving={moving}
          ownerId={ownerId}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
      {roots.hasNextPage && (
        <PickerMore depth={1} loading={roots.isFetchingNextPage} onMore={() => void roots.fetchNextPage()} />
      )}
    </>
  );
}

export function MoveDialog({ item, onClose }: { item: KnowledgeItem; onClose: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const [spot, setSpot] = useState<Spot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = item.space === 'personal' && item.owner_id === me.id;
  const moving = item.type === 'folder' ? item.id : null;
  const here = spotKey({ folder: item.folder_id, space: item.space });

  const submit = async () => {
    if (!spot) return setError(t('knowledge.pickPlace'));
    if (spotKey(spot) === here) return onClose();
    setBusy(true);
    const input = spot.folder ? { folder_id: spot.folder } : { folder_id: null, space: spot.space };
    try {
      if (item.type === 'folder') await api.knowledge.folders.update(item.id, input);
      else if (item.type === 'doc') await api.knowledge.docs.update(item.id, input);
      else await api.knowledge.files.update(item.id, input);
      void refreshTree(client);
      void client.invalidateQueries({ queryKey: ['docs', 'one', item.id] });
      onClose();
      notify(t('knowledge.moved', { name: item.name, place: spot.name }));
    } catch (caught) {
      setError(errorText(caught, t));
      setBusy(false);
    }
  };

  const selected = spot ? spotKey(spot) : '';
  const choose = (next: Spot) => {
    setSpot(next);
    setError('');
  };
  return (
    <Overlay variant="dialog" title={t('knowledge.moveTitle', { name: item.name })} onClose={onClose}>
      <div className="app-picker" role="radiogroup" aria-label={t('knowledge.where')}>
        {item.space === 'team' ? (
          <Root
            scope="team"
            label={t('knowledge.teamRoot')}
            rootChoice
            moving={moving}
            ownerId={null}
            selected={selected}
            onSelect={choose}
          />
        ) : mine ? (
          <>
            <Root
              scope="personal"
              label={t('knowledge.myRoot')}
              rootChoice
              moving={moving}
              ownerId={me.id}
              selected={selected}
              onSelect={choose}
            />
            <Root
              scope="team"
              label={t('knowledge.teamRoot')}
              rootChoice
              moving={moving}
              ownerId={null}
              selected={selected}
              onSelect={choose}
            />
          </>
        ) : (
          <Root
            scope="shared"
            label={t('knowledge.shared')}
            rootChoice={false}
            moving={moving}
            ownerId={item.owner_id}
            selected={selected}
            onSelect={choose}
          />
        )}
      </div>
      {mine && spot?.space === 'team' && <p className="app-muted">{t('knowledge.toTeamHint')}</p>}
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" loading={busy} onClick={() => void submit()}>
          {t('knowledge.moveHere')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
