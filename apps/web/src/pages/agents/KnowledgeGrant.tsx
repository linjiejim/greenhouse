/** Publication knowledge reads stay in the owner's chosen folders and their current children. */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button, Checkbox, ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeItem } from '@greenhouse/contract';
import { useFolder, useKnowledgeRoots } from '../../data/knowledge';
import { useI18n } from '../../lib/i18n';

function Branch({
  item,
  selected,
  onChange,
  depth = 0,
}: {
  item: KnowledgeItem;
  selected: string[];
  onChange: (ids: string[]) => void;
  depth?: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const folder = useFolder(item.id, open);
  return (
    <>
      <div className="app-picker-row" style={{ paddingLeft: `calc(${depth} * var(--gh-space-4))` }}>
        <Button
          kind="ghost"
          size="sm"
          aria-label={t(open ? 'knowledge.collapse' : 'knowledge.expand', { name: item.name })}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={icon.sm} /> : <ChevronRight size={icon.sm} />}
        </Button>
        <Checkbox
          label={item.name}
          checked={selected.includes(item.id)}
          disabled={!selected.includes(item.id) && selected.length >= 100}
          onChange={(checked) => onChange(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
        />
      </div>
      {open && folder.isPending && <Skeleton lines={1} />}
      {open && folder.isError && <ErrorBox onRetry={() => void folder.refetch()}>{t('common.error')}</ErrorBox>}
      {open &&
        folder.data?.children
          .filter((child) => child.type === 'folder' && !child.agent_id)
          .map((child) => (
            <Branch key={child.id} item={child} selected={selected} onChange={onChange} depth={depth + 1} />
          ))}
      {open && folder.hasNextPage && (
        <Button kind="ghost" onClick={() => void folder.fetchNextPage()}>
          {t('knowledge.showMore')}
        </Button>
      )}
    </>
  );
}

export function KnowledgeGrant({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useI18n();
  const roots = useKnowledgeRoots('personal');
  return (
    <div className="app-picker">
      {roots.isPending && <Skeleton lines={2} />}
      {roots.isError && <ErrorBox onRetry={() => void roots.refetch()}>{t('common.error')}</ErrorBox>}
      {roots.items
        .filter((item) => item.type === 'folder' && !item.agent_id)
        .map((item) => (
          <Branch key={item.id} item={item} selected={selected} onChange={onChange} />
        ))}
      {selected.length > 0 && (
        <Button kind="ghost" size="sm" onClick={() => onChange([])}>
          {t('publish.clearKnowledge')}
        </Button>
      )}
      {roots.hasNextPage && (
        <Button kind="ghost" onClick={() => void roots.fetchNextPage()}>
          {t('knowledge.showMore')}
        </Button>
      )}
    </div>
  );
}
