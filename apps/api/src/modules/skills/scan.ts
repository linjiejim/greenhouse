/**
 * The security scan of a skill, ported from v1's SkillHub scanner and its prompt-injection and
 * secret patterns. A skill is instructions an Agent reads and acts on, so an upload is untrusted
 * input with a short path to execution. Pure: files in, a verdict out, no IO.
 *
 * Only `high` findings hold a skill for review (`suspicious`); `medium` ones are notes for the
 * reviewer. Skills are manuals that legitimately teach commands, so command patterns in Markdown
 * count only inside fenced code (`curl` in a sentence is documentation, `curl … | sh` in a block
 * is an instruction), while links, injection phrases, secrets and hidden characters count
 * anywhere. An excerpt never repeats a secret.
 */

import type { SkillScanFinding } from '@greenhouse/contract';
import { textOf, type PackageFile } from './package.js';

export interface ScanReport {
  status: 'clean' | 'suspicious';
  findings: SkillScanFinding[];
}

type Severity = SkillScanFinding['severity'];

const MAX_EXCERPT = 160;
/** A pathological package cannot write an unbounded column. */
const MAX_FINDINGS = 50;

// ─── Binaries ─────────────────────────────────────────────

interface Magic {
  label: string;
  bytes: number[];
  offset?: number;
}

const EXECUTABLE_MAGICS: Magic[] = [
  { label: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'PE/MZ', bytes: [0x4d, 0x5a] },
  { label: 'Mach-O 32-bit', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { label: 'Mach-O 64-bit', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { label: 'Mach-O 32-bit (LE)', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { label: 'Mach-O 64-bit (LE)', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
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

/** Small pictures are the only binaries a skill legitimately ships. */
const IMAGE_MAGICS: Magic[] = [
  { label: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { label: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { label: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
  { label: 'BMP', bytes: [0x42, 0x4d] },
  { label: 'ICO', bytes: [0x00, 0x00, 0x01, 0x00] },
  { label: 'WEBP', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
];

function matchMagic(bytes: Uint8Array, magics: Magic[]): string | null {
  for (const magic of magics) {
    const at = magic.offset ?? 0;
    if (bytes.length >= at + magic.bytes.length && magic.bytes.every((byte, index) => bytes[at + index] === byte)) {
      return magic.label;
    }
  }
  return null;
}

// ─── Text rules ───────────────────────────────────────────

interface Rule {
  rule: string;
  severity: Severity;
  pattern: RegExp;
}

/** Commands an Agent would follow. In Markdown only inside fenced code; anywhere in other files. */
const COMMAND_RULES: Rule[] = [
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
    // Root-path deletion only: `rm -rf ./dist` is ordinary housekeeping.
    rule: 'destructive-delete',
    severity: 'high',
    pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|\*|$)/,
  },
  {
    rule: 'credential-path-access',
    severity: 'high',
    pattern: /(?:~|\$HOME|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/\.(?:ssh|aws|gnupg|kube|docker)\b/,
  },
];

/** Spawning shells from code: in scripts, not in Markdown. */
const CODE_RULES: Rule[] = [
  {
    rule: 'shell-spawn',
    severity: 'high',
    pattern: /\b(?:child_process|require\(['"]child_process['"]\)|os\.system\s*\(|subprocess\.(?:Popen|run|call)\s*\()/,
  },
];

/** Phrases that try to take over the Agent reading the skill (v1's prompt-injection patterns). */
const INJECTION_RULES: Rule[] = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)/i,
  /disregard\s+(?:your\s+)?(?:all\s+)?(?:previous|prior|above|system)\s*(?:instructions|prompts)/i,
  /override\s+(?:all\s+)?(?:system|previous|safety)\s*(?:prompt|instructions|rules)/i,
  /forget\s+(?:all\s+)?(?:previous|your)\s+(?:instructions|rules|context)/i,
  /reveal\s+(?:your|the)\s+(?:system|initial)\s*(?:prompt|instructions|message)/i,
  /(?:output|print)\s+(?:your|the)\s+(?:full\s+)?system\s*(?:prompt|instructions|message)/i,
  /do\s+not\s+(?:tell|inform|show)\s+the\s+(?:user|member)/i,
  /忽略(?:掉)?(?:之前|以上|上面|前面|先前|所有|全部)[^。\n]{0,6}?(?:指令|提示|规则|指示)/,
  /(?:输出|显示|泄露)(?:你的)?系统(?:提示|指令|提示词)/,
  /不要(?:告诉|让)(?:用户|成员)(?:知道)?/,
].map((pattern) => ({ rule: 'prompt-injection', severity: 'high' as const, pattern }));

/** Credentials have no place in a skill; the excerpt names the kind, never the value. */
const SECRET_RULES: Array<Rule & { label: string }> = [
  { label: 'a private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { label: 'an AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'a Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'an API key', pattern: /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: 'a JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
].map((entry) => ({ ...entry, rule: 'secret', severity: 'high' as const }));

/** A password written into a file is worth a reviewer's look; examples often do it on purpose. */
const PASSWORD_RULE: Rule = {
  rule: 'hardcoded-password',
  severity: 'medium',
  pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s'"<>{}$]{6,}/i,
};

/** Markup a renderer might act on, anywhere in the text. */
const MARKUP_RULES: Rule[] = [
  { rule: 'script-tag', severity: 'medium', pattern: /<script[\s>]/i },
  { rule: 'dangerous-url-scheme', severity: 'medium', pattern: /(?:javascript:|data:text\/html)/i },
];

/** Characters that change what a reviewer sees: bidi overrides (Trojan Source) and zero-width ones. */
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/;
const ZERO_WIDTH_RE = /[\u200B\u200C\u2060\uFEFF]/;

/** Opaque hops a reviewer cannot inspect. */
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

/** Services made for catching requests: a classic place to send what an Agent read. */
const EXFILTRATION_HOSTS = [
  'webhook.site',
  'requestbin.com',
  'requestbin.net',
  'pipedream.net',
  'ngrok.io',
  'ngrok-free.app',
  'ngrok.app',
  'burpcollaborator.net',
  'oastify.com',
  'interact.sh',
  'beeceptor.com',
  'hookbin.com',
];

const URL_RE = /https?:\/\/[^\s"'`)<>\]}]+/gi;

// ─── Helpers ──────────────────────────────────────────────

function flatten(raw: string): string {
  // eslint-disable-next-line no-control-regex -- excerpts are rendered: control characters go
  const flat = raw.replace(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, ' ').trim();
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}…` : flat;
}

/** The line around a match. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return flatten(text.slice(start, end === -1 ? text.length : end));
}

/**
 * The fenced code blocks of a Markdown text, everything else blanked with spaces, so offsets
 * (and the excerpt's line) stay those of the original.
 */
export function fencedCodeOnly(markdown: string): string {
  const out = markdown.split('');
  let inFence = false;
  let cursor = 0;
  for (const line of markdown.split('\n')) {
    const fence = /^\s*(?:```|~~~)/.test(line);
    if (!(inFence && !fence)) for (let index = cursor; index < cursor + line.length; index++) out[index] = ' ';
    if (fence) inFence = !inFence;
    cursor += line.length + 1;
  }
  return out.join('');
}

function isPrivateOrLoopback(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

class Findings {
  readonly items: SkillScanFinding[] = [];
  private readonly seen = new Set<string>();

  add(rule: string, severity: Severity, excerpt: string, path?: string) {
    const key = `${rule}::${path ?? ''}`;
    if (this.seen.has(key) || this.items.length >= MAX_FINDINGS) return;
    this.seen.add(key);
    this.items.push(path ? { rule, severity, path, excerpt } : { rule, severity, excerpt });
  }
}

function scanLinks(text: string, findings: Findings, path?: string) {
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    if (/^https?:\/\/[^/@\s]+:[^/@\s]+@/i.test(url)) {
      findings.add('credentials-in-url', 'high', flatten(url.replace(/\/\/[^/@\s]+@/, '//…@')), path);
      continue;
    }
    const host =
      url
        .replace(/^https?:\/\//i, '')
        .split(/[/?#:]/)[0]
        ?.toLowerCase() ?? '';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && !isPrivateOrLoopback(host)) {
      findings.add('bare-ip-url', 'high', flatten(url), path);
    } else if (EXFILTRATION_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`))) {
      findings.add('exfiltration-endpoint', 'high', flatten(url), path);
    } else if (URL_SHORTENERS.has(host.replace(/^www\./, ''))) {
      findings.add('url-shortener', 'medium', flatten(url), path);
    }
  }
}

function scanText(text: string, findings: Findings, options: { markdown: boolean; path?: string }) {
  const { path } = options;
  const commands = options.markdown ? fencedCodeOnly(text) : text;
  for (const rule of [...COMMAND_RULES, ...(options.markdown ? [] : CODE_RULES)]) {
    const match = rule.pattern.exec(commands);
    if (match) findings.add(rule.rule, rule.severity, lineAt(commands, match.index), path);
  }
  // `chmod +x` alone is harmless; next to a download it is download-then-run.
  if (/\bchmod\s+(?:\+x|[0-7]*[1357][0-7]*)\b/.test(commands) && /\b(?:curl|wget)\b/.test(commands)) {
    findings.add('download-and-execute', 'high', 'chmod +x next to a curl or wget download', path);
  }
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith('#!')) findings.add('shebang', 'medium', flatten(firstLine), path);

  for (const rule of [...INJECTION_RULES, ...MARKUP_RULES]) {
    const match = rule.pattern.exec(text);
    if (match) findings.add(rule.rule, rule.severity, lineAt(text, match.index), path);
  }
  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(text);
    if (match) findings.add(rule.rule, rule.severity, `${rule.label} (${match[0].length} characters, not shown)`, path);
  }
  const password = PASSWORD_RULE.pattern.exec(text);
  if (password) {
    findings.add(PASSWORD_RULE.rule, PASSWORD_RULE.severity, flatten(password[0].replace(/[:=].*$/, ': …')), path);
  }
  const bidi = BIDI_RE.exec(text);
  if (bidi) findings.add('hidden-text', 'high', `a bidirectional control character: ${lineAt(text, bidi.index)}`, path);
  const zeroWidth = ZERO_WIDTH_RE.exec(text);
  if (zeroWidth) findings.add('zero-width-character', 'medium', lineAt(text, zeroWidth.index), path);
  scanLinks(text, findings, path);
}

function scanBinary(file: PackageFile, findings: Findings) {
  const executable = matchMagic(file.bytes, EXECUTABLE_MAGICS);
  if (executable) {
    return findings.add(
      'executable-payload',
      'high',
      `${executable} binary (${file.bytes.byteLength} bytes)`,
      file.path,
    );
  }
  const archive = matchMagic(file.bytes, ARCHIVE_MAGICS);
  if (archive) {
    // A package inside a package hides from every check above it.
    return findings.add('archive-payload', 'high', `${archive} archive (${file.bytes.byteLength} bytes)`, file.path);
  }
  if (!matchMagic(file.bytes, IMAGE_MAGICS)) {
    findings.add('binary-non-image', 'medium', `a binary file (${file.bytes.byteLength} bytes)`, file.path);
  }
}

const verdict = (findings: Findings): ScanReport => ({
  status: findings.items.some((finding) => finding.severity === 'high') ? 'suspicious' : 'clean',
  findings: findings.items,
});

/** Scans every file of a package. */
export function scanPackage(files: readonly PackageFile[]): ScanReport {
  const findings = new Findings();
  for (const file of files) {
    const text = textOf(file.bytes);
    if (text === null) scanBinary(file, findings);
    else scanText(text, findings, { markdown: /\.(?:md|markdown)$/i.test(file.path), path: file.path });
  }
  return verdict(findings);
}

/** Scans a template: its body and the words of its fields, as Markdown. */
export function scanTemplate(input: { body: string; variables: ReadonlyArray<{ label: string; options?: string[] }> }) {
  const findings = new Findings();
  const fields = input.variables.flatMap((field) => [field.label, ...(field.options ?? [])]).join('\n');
  scanText(fields ? `${input.body}\n\n${fields}` : input.body, findings, { markdown: true });
  return verdict(findings);
}
