/**
 * Lightweight syntax highlighting for fenced code — the web's approach
 * (keyword sets + a comment / string tokenizer, packages/ui markdown.tsx) as
 * plain data, split into lines for the code card. Comments and strings are cut
 * out first so keywords inside them stay plain; the rest gets numbers and the
 * language's keywords. Not a parser — enough to make a reply's snippet
 * readable. A fence that isn't a programming language (text, markdown, …)
 * only greys its comment lines.
 */

export type TokKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword';
export interface Tok {
  kind: TokKind;
  text: string;
}

const words = (s: string) => new RegExp(`\\b(?:${s.trim().split(/\s+/).join('|')})\\b`, 'g');

const JS = words(`const let var function return if else for while do switch case break continue new this class
  extends import export from default async await try catch finally throw typeof instanceof in of yield void delete
  null undefined true false interface type enum implements readonly as`);
const PY = words(`def class return if elif else for while import from as try except finally raise with yield lambda
  pass break continue and or not in is None True False self async await print range len`);
const SQL = new RegExp(
  `\\b(?:${'SELECT FROM WHERE INSERT UPDATE DELETE CREATE DROP ALTER TABLE INTO VALUES SET JOIN LEFT RIGHT INNER OUTER ON AND OR NOT NULL AS ORDER BY GROUP HAVING LIMIT OFFSET DISTINCT COUNT SUM AVG MAX MIN LIKE IN BETWEEN EXISTS UNION INDEX PRIMARY KEY FOREIGN REFERENCES CASCADE WITH CASE WHEN THEN ELSE END'.split(' ').join('|')})\\b`,
  'gi',
);
const CSS = words(`display flex grid position margin padding border background color font width height top left
  right bottom z-index overflow opacity transition transform animation none auto inherit initial absolute relative
  fixed sticky important`);
const SH = words(`if then else elif fi for in do done while until case esac function return export local echo
  exit source cd sudo set unset`);
const GENERIC = words(`if else for while do switch case break continue return func fn fun let var val const struct
  enum class interface impl trait type import package use pub mod public private protected static final void new
  try catch finally throw throws guard defer go select match where self Self super this true false nil null None
  async await`);
const DATA = words('true false null yes no');

const LANGS: [RegExp, RegExp, { line: string[]; block?: [string, string] }][] = [
  [/^(js|javascript|jsx|mjs|cjs|ts|typescript|tsx)$/, JS, { line: ['//'], block: ['/*', '*/'] }],
  [/^(py|python)$/, PY, { line: ['#'] }],
  [/^(sql|psql|mysql|sqlite)$/, SQL, { line: ['--'], block: ['/*', '*/'] }],
  [/^(css|scss|less)$/, CSS, { line: ['//'], block: ['/*', '*/'] }],
  [/^(sh|bash|zsh|shell|console|dockerfile|makefile|toml|ini|conf)$/, SH, { line: ['#'] }],
  [/^(json|jsonc|json5|yaml|yml)$/, DATA, { line: ['#', '//'] }],
  [/^(rb|ruby|r|perl)$/, GENERIC, { line: ['#'] }],
  [/^(lua|hs|haskell)$/, GENERIC, { line: ['--'] }],
  [/^(html|xml|svg|vue)$/, DATA, { line: [], block: ['<!--', '-->'] }],
  [
    /^(go|rust|rs|java|kotlin|kt|swift|c|cpp|c\+\+|h|hpp|cs|csharp|php|dart|scala|graphql|gql)$/,
    GENERIC,
    { line: ['//'], block: ['/*', '*/'] },
  ],
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER = /\b\d+(?:\.\d+)?\b/g;

/** Tokens per line (an unknown / prose language: only `//` / `#` comment lines are dimmed). */
export function highlight(code: string, lang: string): Tok[][] {
  const l = lang.trim().toLowerCase();
  const spec = LANGS.find(([re]) => re.test(l));
  if (!spec) return code.split('\n').map((ln) => [{ kind: /^\s*(\/\/|#)/.test(ln) ? 'comment' : 'plain', text: ln }]);
  const [, keywords, comments] = spec;

  const alts = [
    ...comments.line.map((m) => `${esc(m)}[^\\n]*`),
    ...(comments.block ? [`${esc(comments.block[0])}[\\s\\S]*?${esc(comments.block[1])}`] : []),
    `"(?:[^"\\\\\\n]|\\\\.)*"`,
    `'(?:[^'\\\\\\n]|\\\\.)*'`,
    '`(?:[^`\\\\]|\\\\.)*`',
  ];
  const tokenRe = new RegExp(alts.join('|'), 'g');

  const flat: Tok[] = [];
  const plain = (text: string) => {
    // numbers and keywords in what's left (both regexes are global, reset per call)
    const marks: { at: number; end: number; kind: TokKind }[] = [];
    for (const [re, kind] of [
      [NUMBER, 'number'],
      [keywords, 'keyword'],
    ] as const) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (!m[0]) {
          re.lastIndex++;
          continue;
        }
        marks.push({ at: m.index, end: m.index + m[0].length, kind });
      }
    }
    marks.sort((a, b) => a.at - b.at);
    let pos = 0;
    for (const mk of marks) {
      if (mk.at < pos) continue; // overlap (a number inside a keyword-ish word)
      if (mk.at > pos) flat.push({ kind: 'plain', text: text.slice(pos, mk.at) });
      flat.push({ kind: mk.kind, text: text.slice(mk.at, mk.end) });
      pos = mk.end;
    }
    if (pos < text.length) flat.push({ kind: 'plain', text: text.slice(pos) });
  };

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(code))) {
    if (m.index > last) plain(code.slice(last, m.index));
    const tok = m[0];
    const isString = tok[0] === '"' || tok[0] === "'" || tok[0] === '`';
    flat.push({ kind: isString ? 'string' : 'comment', text: tok });
    last = m.index + tok.length;
  }
  if (last < code.length) plain(code.slice(last));

  // split into lines, keeping each piece's kind
  const lines: Tok[][] = [[]];
  for (const tok of flat) {
    const parts = tok.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ kind: tok.kind, text: part });
    });
  }
  return lines;
}
