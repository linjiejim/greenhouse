/**
 * Skill bundle security scanner — heuristic content inspection run inside the
 * publish path (docs/specs/20260805-skillhub-web-upload-and-scan.md).
 *
 * A skill is instructions an agent will read and often act on, so an uploaded
 * bundle is untrusted input with a very direct path to execution. This module
 * looks for the three things that actually distinguish a payload from a manual:
 * executable/archive bytes, shell patterns that fetch-and-run, and metadata or
 * links that try to smuggle markup.
 *
 * Two properties matter as much as the rules themselves:
 *
 * 1. **Pure function, zero import side effects.** No DB, no store, no env — it
 *    takes files + catalog metadata and returns a verdict, so it is trivially
 *    unit-testable and can move elsewhere unchanged.
 * 2. **Only `high` quarantines.** This repo's own first-party skills are, by
 *    construction, manuals that teach an agent to run commands: `pnpm test`,
 *    `docker run` and `curl` are all over them. So command patterns are matched
 *    inside fenced code blocks only for `.md` (prose mentioning curl is
 *    documentation, not a payload), and anything merely noteworthy is recorded
 *    at `medium` for a human to read rather than acted on. The long-term guard
 *    against over-tightening is scanner.test.ts, which walks every pack under
 *    skillhub/ and asserts zero `high` findings.
 */

import type { SkillFile } from './bundle.js';

export type ScanSeverity = 'high' | 'medium';

export interface ScanFinding {
  /** Stable kebab-case rule id — shown in the UI and asserted in tests. */
  rule: string;
  severity: ScanSeverity;
  /** Bundle-relative file path; absent for catalog-metadata findings. */
  path?: string;
  /** A short, control-char-free sample of what matched. */
  excerpt: string;
}

export interface ScanReport {
  /** `suspicious` iff at least one `high` finding — `medium` is informational. */
  status: 'clean' | 'suspicious';
  findings: ScanFinding[];
}

/** Catalog metadata as it will be stored (scanned alongside the files). */
export interface ScanMeta {
  name?: string;
  display_name?: string;
  description?: string;
  tags?: string[];
}

const MAX_EXCERPT = 160;
/** Cap the finding list so a pathological bundle can't write an unbounded column. */
const MAX_FINDINGS = 50;

// ─── Magic bytes ─────────────────────────────────────────

interface Magic {
  label: string;
  bytes: number[];
  /** Byte offset the signature starts at (default 0). */
  offset?: number;
}

const EXECUTABLE_MAGICS: Magic[] = [
  { label: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'PE/MZ', bytes: [0x4d, 0x5a] },
  { label: 'Mach-O 32-bit', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { label: 'Mach-O 64-bit', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { label: 'Mach-O 32-bit (LE)', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { label: 'Mach-O 64-bit (LE)', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  // CAFEBABE is both a Mach-O universal binary and a Java class file.
  { label: 'Mach-O fat / Java class', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { label: 'WebAssembly', bytes: [0x00, 0x61, 0x73, 0x6d] },
];

const ARCHIVE_MAGICS: Magic[] = [
  { label: 'ZIP', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { label: 'ZIP (empty)', bytes: [0x50, 0x4b, 0x05, 0x06] },
  { label: 'ZIP (spanned)', bytes: [0x50, 0x4b, 0x07, 0x08] },
  { label: 'gzip', bytes: [0x1f, 0x8b] },
  { label: 'xz', bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { label: 'bzip2', bytes: [0x42, 0x5a, 0x68] },
  { label: '7-Zip', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
];

/** The allowlist: small visual assets are the only binaries a skill legitimately ships. */
const IMAGE_MAGICS: Magic[] = [
  { label: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { label: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { label: 'GIF87a', bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { label: 'GIF89a', bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { label: 'BMP', bytes: [0x42, 0x4d] },
  { label: 'ICO', bytes: [0x00, 0x00, 0x01, 0x00] },
  { label: 'WEBP', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
];

function matchMagic(buf: Buffer, magics: Magic[]): string | null {
  for (const magic of magics) {
    const at = magic.offset ?? 0;
    if (buf.length < at + magic.bytes.length) continue;
    if (magic.bytes.every((b, i) => buf[at + i] === b)) return magic.label;
  }
  return null;
}

// ─── Text patterns ───────────────────────────────────────

interface TextRule {
  rule: string;
  severity: ScanSeverity;
  pattern: RegExp;
  /** When true the rule only applies to non-Markdown files. */
  codeFilesOnly?: boolean;
}

/**
 * Command patterns. For `.md` these run against fenced code blocks only —
 * `curl` in a sentence is documentation; `curl … | sh` in a block is an
 * instruction the agent will follow.
 */
const COMMAND_RULES: TextRule[] = [
  {
    rule: 'remote-script-execution',
    severity: 'high',
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/i,
  },
  {
    rule: 'encoded-shell-payload',
    severity: 'high',
    pattern: /\bbase64\s+(?:--decode|-{1,2}d\w*)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/i,
  },
  {
    rule: 'obfuscated-eval',
    severity: 'high',
    pattern: /\b(?:eval|Function|exec)\s*\(\s*(?:atob|base64\.b64decode)\s*\(/,
  },
  {
    // Root-path deletion only — `rm -rf ./dist` is ordinary housekeeping.
    rule: 'destructive-delete',
    severity: 'high',
    pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|\*|$)/,
  },
  {
    rule: 'credential-path-access',
    severity: 'high',
    pattern: /(?:~|\$HOME|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/\.(?:ssh|aws|gnupg|kube|docker)\b/,
  },
  {
    rule: 'shell-spawn',
    severity: 'high',
    codeFilesOnly: true,
    pattern: /\b(?:child_process|require\(['"]child_process['"]\)|os\.system\s*\(|subprocess\.(?:Popen|run|call)\s*\()/,
  },
];

/**
 * Markup/link rules. Unlike commands these run over the WHOLE document,
 * including Markdown prose: a `<script>` tag or a `javascript:` link in a
 * sentence is still markup that a renderer might act on, whereas `curl` in a
 * sentence is just documentation.
 */
const MARKUP_RULES: TextRule[] = [
  { rule: 'script-tag', severity: 'medium', pattern: /<script[\s>]/i },
  { rule: 'dangerous-url-scheme', severity: 'medium', pattern: /(?:javascript:|data:text\/html)/i },
];

/** Known link shorteners — an opaque hop the reviewer cannot inspect. */
const URL_SHORTENERS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'is.gd',
  'ow.ly',
  'buff.ly',
  'cutt.ly',
  'rb.gy',
  'shorturl.at',
  'rebrand.ly',
  's.id',
  't.cn',
  'dwz.cn',
  'url.cn',
]);

const URL_RE = /https?:\/\/[^\s"'`)<>\]}]+/gi;
// Control characters in metadata are exactly what this check is for — they
// are how a name or description hides what it really contains from a reviewer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Real HTML tags only — `<placeholder>` in a description is not markup. */
const HTML_TAG_RE = /<\s*\/?\s*(?:script|iframe|img|svg|object|embed|link|style|meta|html|body|div|span|a)\b/i;

// ─── Helpers ─────────────────────────────────────────────

function excerptAround(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEndRaw = text.indexOf('\n', index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  return sanitizeExcerpt(text.slice(lineStart, lineEnd));
}

function sanitizeExcerpt(raw: string): string {
  // Same rationale: excerpts must be safe to render, so control chars are
  // deliberately matched and flattened.
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}…` : flat;
}

/**
 * Concatenate the fenced code blocks of a Markdown document, preserving the
 * original text offsets by blanking everything outside the fences — so an
 * excerpt still reports the real matching line.
 */
export function fencedCodeOnly(markdown: string): string {
  const out = markdown.split('');
  let inFence = false;
  let cursor = 0;
  for (const line of markdown.split('\n')) {
    const isFence = /^\s*(?:```|~~~)/.test(line);
    const keep = inFence && !isFence;
    if (!keep) {
      for (let i = cursor; i < cursor + line.length; i++) out[i] = ' ';
    }
    if (isFence) inFence = !inFence;
    cursor += line.length + 1; // +1 for the consumed '\n'
  }
  return out.join('');
}

function isPrivateOrLoopbackIp(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function decodeBase64(content: string): Buffer {
  return Buffer.from(content, 'base64');
}

/** Text-ness probe: no NUL bytes and mostly printable in the first KiB. */
function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024);
  if (head.includes(0)) return false;
  let printable = 0;
  for (const byte of head) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) printable++;
  }
  return head.length === 0 || printable / head.length > 0.9;
}

// ─── Scan ────────────────────────────────────────────────

class FindingSink {
  readonly findings: ScanFinding[] = [];
  private readonly seen = new Set<string>();

  add(rule: string, severity: ScanSeverity, excerpt: string, path?: string): void {
    const key = `${rule}::${path ?? ''}`;
    if (this.seen.has(key) || this.findings.length >= MAX_FINDINGS) return;
    this.seen.add(key);
    this.findings.push(path ? { rule, severity, path, excerpt } : { rule, severity, excerpt });
  }
}

function scanBinary(file: SkillFile, sink: FindingSink): void {
  const buf = decodeBase64(file.content);
  const executable = matchMagic(buf, EXECUTABLE_MAGICS);
  if (executable) {
    sink.add('executable-payload', 'high', `${executable} binary (${buf.byteLength} bytes)`, file.path);
    return;
  }
  const archive = matchMagic(buf, ARCHIVE_MAGICS);
  if (archive) {
    // A bundle inside a bundle defeats every per-file check above it.
    sink.add('archive-payload', 'high', `${archive} archive (${buf.byteLength} bytes)`, file.path);
    return;
  }
  if (looksLikeText(buf)) {
    // Text that arrived base64-encoded is evasion: the encoding exists for
    // binary assets, and reviewers read the utf8 entries.
    const text = buf.toString('utf8');
    sink.add('encoded-script', 'high', sanitizeExcerpt(text.split('\n')[0] ?? ''), file.path);
    return;
  }
  const image = matchMagic(buf, IMAGE_MAGICS);
  if (!image) {
    sink.add('binary-non-image', 'medium', `unrecognized binary (${buf.byteLength} bytes)`, file.path);
  }
}

function scanLinksAndMarkup(text: string, sink: FindingSink, path?: string): void {
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    const credentials = /^https?:\/\/[^/@\s]+:[^/@\s]+@/i.exec(url);
    if (credentials) {
      sink.add('credentials-in-url', 'high', sanitizeExcerpt(url), path);
      continue;
    }
    const host =
      url
        .replace(/^https?:\/\//i, '')
        .split(/[/?#:]/)[0]
        ?.toLowerCase() ?? '';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && !isPrivateOrLoopbackIp(host)) {
      sink.add('bare-ip-url', 'high', sanitizeExcerpt(url), path);
      continue;
    }
    if (URL_SHORTENERS.has(host.replace(/^www\./, ''))) {
      sink.add('url-shortener', 'medium', sanitizeExcerpt(url), path);
    }
  }
  for (const rule of MARKUP_RULES) {
    const match = rule.pattern.exec(text);
    if (match) sink.add(rule.rule, rule.severity, excerptAround(text, match.index), path);
  }
}

function scanTextFile(file: SkillFile, sink: FindingSink): void {
  const isMarkdown = /\.(?:md|markdown)$/i.test(file.path);
  // Commands run against fenced code for Markdown, whole content otherwise.
  const commandTarget = isMarkdown ? fencedCodeOnly(file.content) : file.content;

  for (const rule of COMMAND_RULES) {
    if (rule.codeFilesOnly && isMarkdown) continue;
    const match = rule.pattern.exec(commandTarget);
    if (match) sink.add(rule.rule, rule.severity, excerptAround(commandTarget, match.index), file.path);
  }

  // `chmod +x` is benign alone; paired with a fetch it is the classic
  // download-then-run sequence.
  if (/\bchmod\s+(?:\+x|[0-7]*[1357][0-7]*)\b/.test(commandTarget) && /\b(?:curl|wget)\b/.test(commandTarget)) {
    sink.add('download-and-execute', 'high', 'chmod +x alongside a curl/wget download', file.path);
  }

  const firstLine = file.content.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith('#!')) {
    // Common for skills that legitimately ship helper scripts, so noted rather
    // than quarantined — the executable-payload rules cover real binaries.
    sink.add('shebang', 'medium', sanitizeExcerpt(firstLine), file.path);
  }

  // Links are scanned across the whole document — a malicious link in prose is
  // exactly the attack, unlike a command in prose.
  scanLinksAndMarkup(file.content, sink, file.path);
}

function scanMetadata(meta: ScanMeta, sink: FindingSink): void {
  const fields: [string, string][] = [
    ['name', meta.name ?? ''],
    ['display_name', meta.display_name ?? ''],
    ['description', meta.description ?? ''],
    ...(meta.tags ?? []).map((t, i): [string, string] => [`tags[${i}]`, t]),
  ];
  for (const [field, value] of fields) {
    if (!value) continue;
    if (HTML_TAG_RE.test(value) || CONTROL_CHAR_RE.test(value)) {
      sink.add('metadata-html', 'high', `${field}: ${sanitizeExcerpt(value)}`);
    }
    scanLinksAndMarkup(value, sink);
  }
}

/**
 * Inspect a validated bundle. Files are expected in canonical form
 * (validateBundleFiles), so paths and encodings are already trustworthy.
 */
export function scanBundle(files: SkillFile[], meta: ScanMeta = {}): ScanReport {
  const sink = new FindingSink();
  for (const file of files) {
    if (file.encoding === 'base64') scanBinary(file, sink);
    else scanTextFile(file, sink);
  }
  scanMetadata(meta, sink);

  const findings = sink.findings;
  return { status: findings.some((f) => f.severity === 'high') ? 'suspicious' : 'clean', findings };
}

/** Only the rules that quarantine — used for log lines and notifications. */
export function highFindings(findings: ScanFinding[]): ScanFinding[] {
  return findings.filter((f) => f.severity === 'high');
}
