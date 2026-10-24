/**
 * Links in rendered Markdown as chips (spec 20261024-v3 B6).
 *
 * Three kinds, decided once per link by {@link decorateMarkdownLinks} while the sanitized HTML
 * is built, then drawn by React through portals ({@link useMarkdownChips}):
 *
 * - **object** — a link to a workspace object (`parseObjectUrl`: document, file, folder, task,
 *   project, table record, conversation). Type icon + the object's current title, fetched in
 *   one batch from `POST /api/refs/resolve` and cached. When the member may not read it the
 *   chip shows only the type, never the title — not even the link text the model wrote.
 *   A file object draws as a file chip (kind icon, name, size).
 * - **file** — any other link whose name or path is a file (`report.pdf`): kind icon + the
 *   name cut in the middle, extension kept.
 * - **external** — another site: globe + domain + the link text, one line, cut in the middle;
 *   a bare URL (text = address) collapses to its domain and a shortened path.
 *
 * The `<a>` stays a real link (href, target, the entity-peek data attributes), so clicks,
 * cmd-click and "copy link" behave as before; only its content changes. The original text
 * stays in the markup as a fallback (hidden by CSS once the chip has drawn), so copy-as-text,
 * exports and the first paint before React's layout effect still read sensibly.
 */

import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  fileExtension,
  fileKindOf,
  looksLikeFileName,
  middleEllipsis,
  parseObjectUrl,
  type FileKind,
  type ObjectRefType,
} from '@greenhouse/types/object-refs';
import {
  CheckSquare,
  FileArchive,
  FileAudio,
  FileBlank,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderKanban,
  Globe,
  MessageSquare,
  Presentation,
  Table2,
  type LucideIcon,
} from '../lib/icons';
import { formatFileSize } from '../lib/file-download';
import { useObjectRef } from '../lib/object-refs';
import { useT } from '../lib/i18n';

/** Characters a chip label may take before it is cut in the middle. */
const LABEL_MAX = 48;
const HOST_MAX = 32;

export type ChipKind = 'object' | 'file' | 'external';

const SLOT_ATTR = 'data-chip-slot';

// ─── DOM pass ────────────────────────────────────────────

function lastPathSegment(href: string): string {
  try {
    const url = new URL(href, 'http://local.invalid');
    const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

function stripProtocol(href: string): string {
  return href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** The URL sent to the resolver: same-origin absolute addresses become their hash route. */
function canonicalObjectUrl(href: string, origin: string): string {
  if (href.startsWith('/#/')) return href.slice(1);
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.origin === origin && url.hash.startsWith('#/')) return url.hash;
    } catch {
      /* fall through */
    }
  }
  return href;
}

function classify(a: HTMLAnchorElement, origin: string): { kind: ChipKind; attrs: Record<string, string> } | null {
  const href = (a.getAttribute('href') || '').trim();
  const text = (a.textContent || '').trim();
  if (!href || href === '#' || a.classList.contains('kb-mention')) return null;
  // Images and other embedded media stay what they are.
  if (a.querySelector('img, video, audio, svg')) return null;

  const ref = parseObjectUrl(href, { origins: [origin] });
  if (ref) {
    const url = canonicalObjectUrl(href, origin);
    return {
      kind: 'object',
      attrs: { 'data-chip-url': url, 'data-chip-type': ref.type, 'data-chip-label': text === href ? '' : text },
    };
  }

  const isHttp = /^https?:\/\//i.test(href);
  const segment = lastPathSegment(href);
  const fileName = looksLikeFileName(text) ? text : looksLikeFileName(segment) ? segment : '';
  if (fileName && (isHttp || href.startsWith('/'))) {
    return { kind: 'file', attrs: { 'data-chip-name': fileName } };
  }

  if (!isHttp) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin === origin) return null;
  const bare = !text || text === href || stripProtocol(text) === stripProtocol(href);
  const host = url.hostname.replace(/^www\./, '');
  const path = `${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  return {
    kind: 'external',
    attrs: { 'data-chip-host': host, 'data-chip-label': bare ? '' : text, 'data-chip-path': bare ? path : '' },
  };
}

/**
 * Turn the links of sanitized Markdown into chip shells. Runs on the on-screen render only
 * (exports and copy-as-HTML keep plain links). `origin` decides which absolute URLs are ours.
 */
export function decorateMarkdownLinks(root: HTMLElement, origin: string): void {
  const doc = root.ownerDocument;
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const chip = classify(a, origin);
    if (!chip) continue;
    const text = a.textContent || '';
    a.setAttribute('data-chip', chip.kind);
    for (const [name, value] of Object.entries(chip.attrs)) a.setAttribute(name, value);
    a.classList.add('md-chip');
    if (chip.kind === 'external') a.setAttribute('title', a.getAttribute('href') || '');
    a.textContent = '';
    const slot = doc.createElement('span');
    slot.setAttribute(SLOT_ATTR, '');
    slot.className = 'md-chip-slot';
    const fallback = doc.createElement('span');
    fallback.className = 'md-chip-fallback';
    fallback.textContent = text;
    a.append(slot, fallback);
  }
}

// ─── React ───────────────────────────────────────────────

const TYPE_ICON: Record<Exclude<ObjectRefType, 'file'>, LucideIcon> = {
  doc: FileText,
  folder: Folder,
  task: CheckSquare,
  project: FolderKanban,
  record: Table2,
  conversation: MessageSquare,
};

const FILE_ICON: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  code: FileCode,
  text: FileText,
  other: FileBlank,
};

export function fileKindIcon(kind: FileKind): LucideIcon {
  return FILE_ICON[kind];
}

function ChipIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size={12} className="md-chip-icon" aria-hidden="true" />;
}

function FileChipBody({ name, size, contentType }: { name: string; size?: number; contentType?: string | null }) {
  const kind = fileKindOf(name, contentType);
  return (
    <>
      <ChipIcon icon={FILE_ICON[kind]} />
      <span className="md-chip-label" title={name}>
        {middleEllipsis(name, LABEL_MAX, { keepExtension: fileExtension(name) !== '' })}
      </span>
      {size !== undefined && <span className="md-chip-meta">{formatFileSize(size)}</span>}
    </>
  );
}

function ObjectChipBody({ url, type, label }: { url: string; type: ObjectRefType; label: string }) {
  const t = useT();
  const lookup = useObjectRef(url);
  const typeName = t(`objectChip.type.${type}`);
  const resolved = lookup.status === 'done' ? lookup.item : undefined;
  // Settled without a title = not readable (or gone): the type only, never the author's text.
  const hidden = lookup.status === 'done' && !resolved?.title;
  const title = resolved?.title || (hidden ? '' : label);

  if (type === 'file' && title) {
    return <FileChipBody name={title} size={resolved?.meta?.size} contentType={resolved?.meta?.contentType} />;
  }
  return (
    <>
      <ChipIcon icon={type === 'file' ? FileBlank : TYPE_ICON[type]} />
      <span className={`md-chip-label${title ? '' : ' md-chip-label-muted'}`} title={title || typeName}>
        {title ? middleEllipsis(title, LABEL_MAX) : typeName}
      </span>
    </>
  );
}

function ExternalChipBody({ host, label, path }: { host: string; label: string; path: string }) {
  const text = label || (path ? `${host}${path}` : host);
  return (
    <>
      <ChipIcon icon={Globe} />
      {label ? (
        <>
          <span className="md-chip-host">{middleEllipsis(host, HOST_MAX)}</span>
          <span className="md-chip-label">{middleEllipsis(text, LABEL_MAX)}</span>
        </>
      ) : (
        <span className="md-chip-label">{middleEllipsis(text, LABEL_MAX)}</span>
      )}
    </>
  );
}

/** What one chip shell asks to be drawn as — read from its `<a>`'s data attributes. */
export function ChipBody({ anchor }: { anchor: HTMLElement }) {
  const data = anchor.dataset;
  switch (data.chip as ChipKind) {
    case 'object':
      return (
        <ObjectChipBody
          url={data.chipUrl ?? ''}
          type={(data.chipType ?? 'doc') as ObjectRefType}
          label={data.chipLabel ?? ''}
        />
      );
    case 'file':
      return <FileChipBody name={data.chipName ?? ''} />;
    case 'external':
      return <ExternalChipBody host={data.chipHost ?? ''} label={data.chipLabel ?? ''} path={data.chipPath ?? ''} />;
    default:
      return null;
  }
}

/**
 * Draw the chips inside a container whose HTML came from {@link decorateMarkdownLinks}.
 * Re-scans whenever `html` changes (streaming replies change it every few tokens).
 */
export function useMarkdownChips(containerRef: React.RefObject<HTMLElement | null>, html: string): React.ReactNode {
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const root = containerRef.current;
    setSlots(root ? Array.from(root.querySelectorAll<HTMLElement>(`[${SLOT_ATTR}]`)) : []);
  }, [containerRef, html]);
  return slots.map((slot, index) => {
    const anchor = slot.parentElement;
    return anchor ? createPortal(<ChipBody anchor={anchor} />, slot, `${index}`) : null;
  });
}
