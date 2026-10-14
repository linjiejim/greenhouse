/**
 * The doc editor (KNOW-03, KNOW-04): @greenhouse/knowledge-editor in the page, with a toolbar and
 * the three menus it reports — `/` blocks, `[[` docs (found with the knowledge search), `@`
 * members. Pictures pasted, dropped or chosen upload to the doc and show where they were put. The
 * editor holds the draft; the page asks it for Markdown when saving.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Code,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  TableColumnsSplit,
  TableRowsSplit,
  TextQuote,
  Trash2,
  Undo2,
  User,
  Minus,
  type LucideIcon,
} from 'lucide-react';
import {
  BLOCKS,
  createDocEditor,
  type BlockId,
  type DocEditor as Instance,
  type SuggestionView,
} from '@greenhouse/knowledge-editor/editor';
import { Button, Field, IconButton, Input, Overlay, OverlayActions, useFloating } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../i18n/zh';

/** Other words that find a block in the `/` menu, whatever the language on screen. */
const BLOCK_WORDS: Record<BlockId, { label: MessageKey; keywords: string; icon: LucideIcon }> = {
  paragraph: { label: 'knowledge.block.paragraph', keywords: 'text paragraph 正文 文本', icon: FileText },
  heading1: { label: 'knowledge.block.heading1', keywords: 'h1 heading title 标题', icon: Heading1 },
  heading2: { label: 'knowledge.block.heading2', keywords: 'h2 heading 标题', icon: Heading2 },
  heading3: { label: 'knowledge.block.heading3', keywords: 'h3 heading 标题', icon: Heading3 },
  bulletList: { label: 'knowledge.block.bulletList', keywords: 'bullet list ul 列表', icon: List },
  orderedList: { label: 'knowledge.block.orderedList', keywords: 'number ordered list ol 列表', icon: ListOrdered },
  blockquote: { label: 'knowledge.block.blockquote', keywords: 'quote 引用', icon: TextQuote },
  codeBlock: { label: 'knowledge.block.codeBlock', keywords: 'code 代码', icon: SquareCode },
  table: { label: 'knowledge.block.table', keywords: 'table grid 表格', icon: Table },
  horizontalRule: { label: 'knowledge.block.horizontalRule', keywords: 'divider rule hr 分隔', icon: Minus },
  image: { label: 'knowledge.block.image', keywords: 'image picture photo 图片', icon: ImagePlus },
};

export interface DocEditorHandle {
  markdown(): string;
  /** Whether the content differs from what the editor loaded (a save sends it only then). */
  changed(): boolean;
  focus(): void;
}

function ToolButton({
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      size="sm"
      label={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active}
      className={cx('app-editor-tool', active && 'is-active')}
      disabled={disabled}
      // Keep the selection in the editor while pressing a button.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </IconButton>
  );
}

/** The open `/`, `[[` or `@` menu, under the caret and inside the window. */
function SuggestionMenu({ menu, instance }: { menu: SuggestionView; instance: Instance | null }) {
  const { t } = useI18n();
  const anchor = useRef(menu.rect);
  anchor.current = menu.rect ?? anchor.current;
  const { panel, style } = useFloating<HTMLUListElement>(true, { rect: () => anchor.current });
  return (
    <ul
      ref={panel}
      className="app-mention-list app-editor-menu"
      role="listbox"
      aria-label={
        menu.kind === 'block'
          ? t('knowledge.blocks')
          : menu.kind === 'doc'
            ? t('knowledge.linkDoc')
            : t('knowledge.mention')
      }
      style={style}
    >
      {menu.items.map((item, index) => {
        const key = 'id' in item ? item.id : String(index);
        const label = 'label' in item ? item.label : 'title' in item ? item.title : item.name;
        const hint = 'hint' in item ? item.hint : undefined;
        const Icon =
          menu.kind === 'block'
            ? BLOCK_WORDS[(item as { id: BlockId }).id].icon
            : menu.kind === 'doc'
              ? FileText
              : User;
        return (
          <li
            key={key}
            role="option"
            aria-selected={index === menu.active}
            className={cx('app-mention-option', index === menu.active && 'is-active')}
            onPointerMove={() => index !== menu.active && instance?.highlight(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => instance?.choose(index)}
          >
            <Icon size={icon.md} strokeWidth={icon.stroke} aria-hidden />
            <span>{label}</span>
            {hint && <span className="app-mention-hint">{hint}</span>}
          </li>
        );
      })}
      {!menu.items.length && <li className="app-mention-option is-disabled">{t('common.loading')}</li>}
    </ul>
  );
}

export function DocEditor({
  docId,
  markdown,
  onChange,
  onUploads,
  handle,
}: {
  docId: string;
  /** The content to start from; the editor keeps the draft from then on. */
  markdown: string;
  onChange: () => void;
  /** Pictures still uploading: they are not in the Markdown until they land. */
  onUploads: (count: number) => void;
  handle: { current: DocEditorHandle | null };
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [menu, setMenu] = useState<SuggestionView | null>(null);
  const [, setTick] = useState(0);
  const [pictureError, setPictureError] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const latest = useRef({ onChange, onUploads, t, docId });
  latest.current = { onChange, onUploads, t, docId };

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    element.replaceChildren();
    let frame = 0;
    const { t: translate } = latest.current;
    const created = createDocEditor({
      element,
      markdown,
      label: translate('knowledge.body'),
      placeholder: translate('knowledge.editorPlaceholder'),
      uploadingLabel: translate('knowledge.uploadingPicture'),
      taskLabel: (words) => words.trim() || latest.current.t('knowledge.emptyItem'),
      blocks: BLOCKS.map((id) => ({ id, label: translate(BLOCK_WORDS[id].label), keywords: BLOCK_WORDS[id].keywords })),
      findDocs: async (query) => {
        const own = latest.current.docId;
        if (!query.trim()) {
          const recent = await api.knowledge.docs.list({ limit: 9 });
          return recent.items.filter((item) => item.id !== own).map((item) => ({ id: item.id, title: item.name }));
        }
        const found = await api.knowledge.search({ q: query.trim(), limit: 9 });
        return found.items
          .filter((hit) => hit.type === 'doc' && hit.id !== own)
          .map((hit) => ({ id: hit.id, title: hit.title, hint: hit.path.map((entry) => entry.name).join(' / ') }));
      },
      findMembers: async (query) => {
        const found = await api.members.directory(query.trim() || undefined);
        return found.items.map((member) => ({ id: member.id, name: member.name, hint: member.email }));
      },
      uploadImage: async (file) => {
        try {
          const stored = await api.knowledge.files.upload(file, { doc_id: latest.current.docId });
          setPictureError('');
          return stored.url;
        } catch (error) {
          setPictureError(latest.current.t('knowledge.pictureFailed', { reason: errorText(error, latest.current.t) }));
          return null;
        }
      },
      requestImage: () => picker.current?.click(),
      onSuggest: setMenu,
      onChange: () => latest.current.onChange(),
      onUploads: (count) => latest.current.onUploads(count),
      onSelection: () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => setTick((value) => value + 1));
      },
    });
    setInstance(created);
    // What the doc reads as in the editor before any change: Markdown written another way (`*`
    // bullets, say) is only rewritten when someone changes the body.
    const loaded = created.markdown();
    handle.current = {
      markdown: created.markdown,
      changed: () => created.markdown() !== loaded,
      focus: () => created.editor.commands.focus(),
    };
    return () => {
      cancelAnimationFrame(frame);
      handle.current = null;
      created.destroy();
      setInstance(null);
    };
    // The editor is made once per mount: the page remounts it to load another version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = instance?.editor;
  const run = (command: (chain: ReturnType<NonNullable<typeof editor>['chain']>) => { run(): boolean }) => {
    if (editor) command(editor.chain().focus()).run();
  };
  const is = (name: string, attributes?: Record<string, unknown>) => !!editor?.isActive(name, attributes);
  const inTable = is('table');

  const openLink = () => {
    if (!editor) return;
    setLinking(String(editor.getAttributes('link').href ?? ''));
  };

  return (
    <div className="app-editor">
      <div className="app-editor-toolbar" role="toolbar" aria-label={t('knowledge.formatting')}>
        <ToolButton
          label={t('knowledge.tool.undo')}
          shortcut="⌘Z"
          disabled={!editor?.can().undo()}
          onClick={() => run((chain) => chain.undo())}
        >
          <Undo2 size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t('knowledge.tool.redo')}
          shortcut="⇧⌘Z"
          disabled={!editor?.can().redo()}
          onClick={() => run((chain) => chain.redo())}
        >
          <Redo2 size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <span className="app-editor-sep" aria-hidden />
        {([1, 2, 3] as const).map((level) => {
          const Icon = level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3;
          return (
            <ToolButton
              key={level}
              label={t(BLOCK_WORDS[`heading${level}`].label)}
              active={is('heading', { level })}
              onClick={() => run((chain) => chain.toggleHeading({ level }))}
            >
              <Icon size={icon.md} strokeWidth={icon.stroke} />
            </ToolButton>
          );
        })}
        <span className="app-editor-sep" aria-hidden />
        <ToolButton
          label={t('knowledge.tool.bold')}
          shortcut="⌘B"
          active={is('bold')}
          onClick={() => run((chain) => chain.toggleBold())}
        >
          <Bold size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t('knowledge.tool.italic')}
          shortcut="⌘I"
          active={is('italic')}
          onClick={() => run((chain) => chain.toggleItalic())}
        >
          <Italic size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t('knowledge.tool.strike')}
          active={is('strike')}
          onClick={() => run((chain) => chain.toggleStrike())}
        >
          <Strikethrough size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t('knowledge.tool.code')}
          active={is('code')}
          onClick={() => run((chain) => chain.toggleCode())}
        >
          <Code size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton label={t('knowledge.tool.link')} active={is('link')} onClick={openLink}>
          <Link2 size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <span className="app-editor-sep" aria-hidden />
        <ToolButton
          label={t(BLOCK_WORDS.bulletList.label)}
          active={is('bulletList')}
          onClick={() => run((chain) => chain.toggleBulletList())}
        >
          <List size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t(BLOCK_WORDS.orderedList.label)}
          active={is('orderedList')}
          onClick={() => run((chain) => chain.toggleOrderedList())}
        >
          <ListOrdered size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t(BLOCK_WORDS.blockquote.label)}
          active={is('blockquote')}
          onClick={() => run((chain) => chain.toggleBlockquote())}
        >
          <TextQuote size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t(BLOCK_WORDS.codeBlock.label)}
          active={is('codeBlock')}
          onClick={() => run((chain) => chain.toggleCodeBlock())}
        >
          <SquareCode size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t(BLOCK_WORDS.horizontalRule.label)}
          onClick={() => run((chain) => chain.setHorizontalRule())}
        >
          <Minus size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton label={t(BLOCK_WORDS.image.label)} onClick={() => picker.current?.click()}>
          <ImagePlus size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        <ToolButton
          label={t(BLOCK_WORDS.table.label)}
          active={inTable}
          disabled={inTable}
          onClick={() => run((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
        >
          <Table size={icon.md} strokeWidth={icon.stroke} />
        </ToolButton>
        {inTable && (
          <>
            <ToolButton label={t('knowledge.tool.addRow')} onClick={() => run((chain) => chain.addRowAfter())}>
              <BetweenHorizontalEnd size={icon.md} strokeWidth={icon.stroke} />
            </ToolButton>
            <ToolButton label={t('knowledge.tool.addColumn')} onClick={() => run((chain) => chain.addColumnAfter())}>
              <BetweenVerticalEnd size={icon.md} strokeWidth={icon.stroke} />
            </ToolButton>
            <ToolButton label={t('knowledge.tool.deleteRow')} onClick={() => run((chain) => chain.deleteRow())}>
              <TableRowsSplit size={icon.md} strokeWidth={icon.stroke} />
            </ToolButton>
            <ToolButton label={t('knowledge.tool.deleteColumn')} onClick={() => run((chain) => chain.deleteColumn())}>
              <TableColumnsSplit size={icon.md} strokeWidth={icon.stroke} />
            </ToolButton>
            <ToolButton label={t('knowledge.tool.deleteTable')} onClick={() => run((chain) => chain.deleteTable())}>
              <Trash2 size={icon.md} strokeWidth={icon.stroke} />
            </ToolButton>
          </>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          aria-label={t(BLOCK_WORDS.image.label)}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) instance?.insertImages(files);
          }}
        />
      </div>
      <div ref={host} className="app-editor-surface app-markdown app-doc-content" />
      {pictureError && (
        <p className="app-form-error" role="alert">
          {pictureError}
        </p>
      )}
      {menu && (menu.items.length > 0 || menu.loading) && <SuggestionMenu menu={menu} instance={instance} />}
      {linking !== null && (
        <LinkDialog
          initial={linking}
          onClose={() => setLinking(null)}
          onSave={(href) => {
            setLinking(null);
            if (!editor) return;
            const chain = editor.chain().focus().extendMarkRange('link');
            if (href) chain.setLink({ href }).run();
            else chain.unsetLink().run();
          }}
        />
      )}
    </div>
  );
}

/** Adds, changes or removes a link on the selected text. Only web, mail and in-app addresses. */
function LinkDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose: () => void;
  onSave: (href: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const submit = () => {
    const href = value.trim();
    if (href && !/^(?:https?:\/\/|mailto:|#\/)/i.test(href)) return setError(t('knowledge.linkInvalid'));
    onSave(href);
  };
  return (
    <Overlay variant="dialog" title={t('knowledge.tool.link')} onClose={onClose}>
      <form
        className="app-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label={t('knowledge.linkAddress')} error={error || undefined} description={t('knowledge.linkHint')}>
          <Input
            data-autofocus
            value={value}
            placeholder="https://"
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
          />
        </Field>
      </form>
      <OverlayActions>
        {initial && (
          <Button className="app-actions-start" kind="ghost" onClick={() => onSave('')}>
            {t('knowledge.removeLink')}
          </Button>
        )}
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" onClick={submit}>
          {t('knowledge.applyLink')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
