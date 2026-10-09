/**
 * Agent output → notification bodies.
 *
 * A scheduled task's summary is the assistant's final message, and that message
 * was written for the chat renderer: Markdown, plus the Rich Output fences
 * (```datatable, ```chart, ```mermaid, ```html-preview…) that the rich-output
 * guide (`composeRichOutput`) actively instructs every `rich_output` profile to emit. Every delivery channel
 * used to forward that string raw — the email builder even HTML-escaped the whole
 * thing into a `white-space:pre-wrap` div — so the reader got a wall of Markdown
 * syntax with a JSON blob sitting in the middle of it. The only renderer that
 * understands those fences lives in the browser, and an email has no browser.
 *
 * Hence a delivery-side renderer, in two steps:
 *
 *   `flattenForDelivery()`     fences → ordinary Markdown (a datatable becomes a
 *                              Markdown table; a diagram becomes a one-line note
 *                              pointing at the session). Every channel calls it,
 *                              and its output *is* the text/plain body — Markdown
 *                              is what a plain-text alternative should look like.
 *   `renderNotificationEmail()` that Markdown → an HTML document.
 *
 * Two steps rather than two renderers, deliberately: the HTML body is produced
 * FROM the text body, so the two parts of one multipart email cannot drift into
 * describing different results.
 *
 * Why `marked` directly instead of `@greenhouse/knowledge-editor/md-html`: that
 * function's contract is "HTML the knowledge editor schema can consume" — bare
 * semantic tags, raw HTML passed through, no notion of a mail client. Email needs
 * the opposite of two of those three. It is the same library underneath, not a
 * second Markdown implementation.
 */

import { Marked, Renderer, type Tokens } from 'marked';
import { flattenRichOutput, type FlattenNotes } from '@greenhouse/types/rich-output';
import { escapeHtml } from '@greenhouse/utils/html';
import { getProductName } from '@greenhouse/utils/brand';

/**
 * Copy for blocks that cannot survive the trip. Saying "a diagram was here, open
 * the session" is the honest answer; silently dropping it would make the email
 * claim the agent produced less than it did.
 */
const NOTE_DIAGRAM = '（图示无法在邮件中显示，请打开会话查看）';
const NOTE_PREVIEW = '（网页预览无法在邮件中显示，请打开会话查看）';
const NOTE_CONFIRM = '（需要确认的操作，请打开会话处理）';
const HEADING_ARTIFACTS = '产物文件';
const HEADING_ATTACHMENTS = '附件';

// ─── Markdown flattening ─────────────────────────────────

/** What a delivered message says where a block cannot be drawn. */
const DELIVERY_NOTES: FlattenNotes = {
  diagram: () => `> ${NOTE_DIAGRAM}`,
  preview: (segment) => `> ${segment.title ? `${segment.title} ${NOTE_PREVIEW}` : NOTE_PREVIEW}`,
  confirm: (data) =>
    [
      data.text.trim(),
      `> ${NOTE_CONFIRM}${data.actions.length ? `：${data.actions.map((a) => a.label).join(' / ')}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  artifactsHeading: HEADING_ARTIFACTS,
  attachmentsHeading: HEADING_ATTACHMENTS,
  boolean: (value) => (value ? '是' : '否'),
  stepStatus: (status) =>
    ({ done: '已完成', active: '进行中', pending: '待开始', blocked: '受阻', skipped: '已跳过' })[status],
};

/**
 * Agent output with every Rich Output fence turned into ordinary Markdown, in
 * the wording of a delivered message. The per-block conversion lives with the
 * block registry (`flattenRichOutput` in @greenhouse/types/rich-output); this
 * only supplies the notes.
 */
export function flattenForDelivery(markdown: string): string {
  return flattenRichOutput(markdown, DELIVERY_NOTES);
}

// ─── Markdown → email HTML ───────────────────────────────

/**
 * Only absolute `http(s)`/`mailto` URLs survive into the document. A site-relative
 * path is resolved against `PUBLIC_BASE_URL` because a mail client has no origin
 * to resolve it against; anything else (including the `#/crm/...` hash deeplinks
 * the agent is told to cite) is dropped, since a link that cannot work is worse than
 * plain text — and `javascript:` never belongs in markup we compose.
 */
function safeUrl(href: string | null | undefined): string | null {
  const raw = (href ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('/')) {
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
    return base ? `${base}${raw}` : null;
  }
  return /^(https?:|mailto:)/i.test(raw) ? raw : null;
}

/**
 * `breaks: true` matches the chat renderer the agent writes for, so a summary
 * that reads as separate lines on screen reads that way in the inbox too. A
 * private instance, not the module singleton, for the same reason
 * `markdownToEditorHtml` keeps one: options set for another caller must not leak
 * in here.
 *
 * The overrides go in as a plain object, NOT a `Renderer` subclass: `use()` picks
 * up methods with `Object.keys`, which sees own properties only, so a subclass's
 * prototype methods are silently ignored and every override quietly does nothing.
 */
const emailMarked = new Marked({ gfm: true, breaks: true });

emailMarked.use({
  renderer: {
    /**
     * Raw HTML in the summary is model-authored and this output goes into a
     * document we compose. `marked` passes it through verbatim, so it has to be
     * neutralised here — the builder this replaces was escaping the entire
     * summary, and dropping that without a replacement is exactly how a renderer
     * becomes an injection sink.
     */
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },

    link(this: Renderer, { href, title, tokens }: Tokens.Link): string {
      const label = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return label;
      return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`;
    },

    image({ href, title, text }: Tokens.Image): string {
      const url = safeUrl(href);
      // Without a resolvable URL the client shows a broken-image box; the alt
      // text at least says what was supposed to be there.
      if (!url) return escapeHtml(text ?? '');
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text ?? '')}"${title ? ` title="${escapeHtml(title)}"` : ''} />`;
    },
  },
});

/**
 * Element styling rides in a `<style>` block rather than being inlined on every
 * tag. Inlining is the belt-and-braces answer for bulk mail aimed at unknown
 * clients; this is internal mail to a handful of known ones, all of which have
 * supported `<style>` in `<head>` for years. If one ever strips it the content
 * degrades to unstyled-but-correct semantic HTML — a borderless table, not a wall
 * of JSON.
 */
const BODY_STYLES = `
.gh-md{color:#17221c;font-size:15px;line-height:1.65}
.gh-md h1,.gh-md h2,.gh-md h3,.gh-md h4{margin:20px 0 8px;line-height:1.3}
.gh-md h1{font-size:20px}.gh-md h2{font-size:18px}.gh-md h3{font-size:16px}.gh-md h4{font-size:15px}
.gh-md p{margin:0 0 12px}
.gh-md ul,.gh-md ol{margin:0 0 12px;padding-left:22px}
.gh-md li{margin:4px 0}
.gh-md table{border-collapse:collapse;margin:0 0 16px;font-size:14px}
.gh-md th,.gh-md td{border:1px solid #dfe8e2;padding:6px 10px;text-align:left;vertical-align:top}
.gh-md th{background:#f4f7f5;font-weight:600}
.gh-md pre{background:#f4f7f5;border:1px solid #dfe8e2;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px}
.gh-md code{background:#f4f7f5;border-radius:4px;padding:1px 4px;font-size:13px}
.gh-md pre code{background:none;padding:0}
.gh-md blockquote{margin:0 0 12px;padding:2px 0 2px 12px;border-left:3px solid #dfe8e2;color:#526159}
.gh-md a{color:#18864b}
.gh-md hr{border:0;border-top:1px solid #dfe8e2;margin:20px 0}
.gh-md img{max-width:100%;height:auto}
`.trim();

export interface NotificationEmail {
  heading: string;
  /** Agent-authored Markdown — run it through `flattenForDelivery` first. */
  body: string;
  link?: { url: string; label: string } | null;
}

/** Wrap an agent-authored Markdown body in the Greenhouse notification shell. */
export function renderNotificationEmail({ heading, body, link }: NotificationEmail): string {
  const content = emailMarked.parse(body, { async: false }) as string;
  const linkRow = link
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(link.url)}" style="display:inline-block;background:#18864b;color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:10px">${escapeHtml(link.label)}</a></p>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${BODY_STYLES}</style></head><body style="margin:0;background:#f4f7f5;color:#17221c;font-family:Inter,'PingFang SC','Microsoft YaHei',Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border:1px solid #dfe8e2;border-radius:16px"><tr><td style="padding:32px"><div style="font-size:12px;font-weight:700;color:#18864b;letter-spacing:.08em">${escapeHtml(getProductName().toUpperCase())}</div><h1 style="margin:12px 0 20px;font-size:22px;line-height:1.3">${escapeHtml(heading)}</h1><div class="gh-md">${content}</div>${linkRow}</td></tr></table></td></tr></table></body></html>`;
}
