import { Check, Film, ImageOff, Sparkles } from 'lucide-react';
import { formatDuration } from '../i18n';
import type { AssetCard } from '../types';

export function Thumb({ asset, className }: { asset: AssetCard; className?: string }) {
  return asset.thumb_url ? (
    <img src={asset.thumb_url} alt="" loading="lazy" draggable={false} className={`h-full w-full object-cover ${className ?? ''}`} />
  ) : (
    <div className={`flex h-full w-full items-center justify-center bg-surface-muted text-fg-faint ${className ?? ''}`}>
      {asset.kind === 'video' ? <Film size={28} /> : <ImageOff size={28} />}
    </div>
  );
}

export function Tile({
  asset,
  selected,
  selecting,
  onOpen,
  onToggle,
}: {
  asset: AssetCard;
  selected: boolean;
  selecting: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="group relative flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        onClick={(e) => (selecting || e.metaKey || e.ctrlKey || e.shiftKey ? onToggle() : onOpen())}
        className={`relative aspect-square overflow-hidden rounded-xl border bg-surface-muted ${selected ? 'border-accent ring-2 ring-accent' : 'border-edge'}`}
        aria-label={asset.title}
      >
        <Thumb asset={asset} />
        {asset.kind === 'video' ? (
          <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[12px] font-semibold text-white">
            {asset.duration_ms ? formatDuration(asset.duration_ms) : <Film size={12} />}
          </span>
        ) : null}
        {asset.title_from === 'ai' ? (
          <span className="absolute top-1.5 left-1.5 rounded-md bg-black/50 p-1 text-white" title="AI">
            <Sparkles size={12} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label="select"
        aria-pressed={selected}
        onClick={onToggle}
        className={`absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white shadow ${
          selected ? 'bg-accent text-on-accent' : 'bg-black/30 text-transparent opacity-0 group-hover:opacity-100'
        } ${selecting ? 'opacity-100' : ''}`}
      >
        <Check size={14} />
      </button>
      <div className="truncate text-[13px] text-fg" title={asset.title}>
        {asset.title}
      </div>
    </div>
  );
}
