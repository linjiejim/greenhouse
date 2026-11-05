import { Check, Film, ImageOff, Sparkles } from 'lucide-react';
import { useT } from '../i18n';
import { formatDuration } from '../i18n';
import type { AssetCard } from '../types';

export function Thumb({ asset, className }: { asset: AssetCard; className?: string }) {
  return asset.thumb_url ? (
    <img src={asset.thumb_url} alt="" loading="lazy" draggable={false} className={`h-full w-full object-cover ${className ?? ''}`} />
  ) : (
    <div className={`flex h-full w-full items-center justify-center bg-sunken text-faint-foreground ${className ?? ''}`}>
      {asset.kind === 'video' ? <Film size={28} /> : <ImageOff size={28} />}
    </div>
  );
}

/** Marks drawn on top of a photo keep a fixed dark ground and light edge, whatever the theme. */
const ON_PHOTO = {
  badge: 'bg-black/60 text-white', // design-allow: legible on any photo
  ai: 'bg-black/50 text-white', // design-allow: legible on any photo
  ring: 'border-white', // design-allow: legible on any photo
  idle: 'bg-black/30 text-transparent', // design-allow: legible on any photo
};

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
  const t = useT();
  return (
    <div className="group relative flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        onClick={(e) => (selecting || e.metaKey || e.ctrlKey || e.shiftKey ? onToggle() : onOpen())}
        className={`relative aspect-square overflow-hidden rounded-card border bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${selected ? 'border-ring ring-2 ring-ring' : 'border-border'}`}
        aria-label={asset.title}
      >
        <Thumb asset={asset} />
        {asset.kind === 'video' ? (
          <span className={`absolute right-1.5 bottom-1.5 rounded-md px-1.5 py-0.5 text-caption font-semibold ${ON_PHOTO.badge}`}>
            {asset.duration_ms ? formatDuration(asset.duration_ms) : <Film size={12} />}
          </span>
        ) : null}
        {asset.title_from === 'ai' ? (
          <span className={`absolute top-1.5 left-1.5 rounded-md p-1 ${ON_PHOTO.ai}`} title="AI">
            <Sparkles size={12} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`${t('select')} ${asset.title}`}
        aria-pressed={selected}
        onClick={onToggle}
        className={`absolute top-1 right-1 flex h-8 w-8 items-center justify-center rounded-full border-2 pointer-coarse:opacity-100 focus-visible:opacity-100 ${ON_PHOTO.ring} ${
          selected ? 'bg-primary text-primary-foreground' : `${ON_PHOTO.idle} opacity-0 group-hover:opacity-100`
        } ${selecting ? 'opacity-100' : ''}`}
      >
        <Check size={14} />
      </button>
      <div className="truncate text-body-sm text-foreground" title={asset.title}>
        {asset.title}
      </div>
    </div>
  );
}
