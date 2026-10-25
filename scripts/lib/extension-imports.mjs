/**
 * Import-edge rules for extension code (used by scripts/check-extension-overlay.mjs).
 *
 * A file under `apps/<api|web>/src/extensions/<id>/` may import only:
 *   - files of its own extension directory (or another extension's directory —
 *     the cross-extension case `dependsOn` documents);
 *   - its app's kit, `apps/<app>/src/extension-kit`;
 *   - `@greenhouse/types` and `@greenhouse/types/*`, `@greenhouse/crud` (and subpaths);
 *   - third-party packages and node builtins.
 * Everything else in core is internal. Test files are exempt (they may reach
 * core test hooks).
 */
import { posix } from 'node:path';

const EXTENSION_FILE = /^apps\/(api|web)\/src\/extensions\/([^/]+)\/.+\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|\.e2e\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|(?:^|\/)e2e\/)/;
const ALLOWED_PACKAGES = [/^@greenhouse\/types(?:\/.*)?$/, /^@greenhouse\/crud(?:\/.*)?$/];

/** `{ app, id }` when `file` (repo-relative, posix) is extension source the rule applies to; else null. */
export function extensionFileInfo(file) {
  const m = EXTENSION_FILE.exec(file);
  if (!m) return null;
  return { app: m[1], id: m[2], test: TEST_FILE.test(file) };
}

/** Replace comments with spaces (newlines kept) without touching string or template literals. */
export function blankComments(text) {
  return scan(text).clean;
}

/**
 * One pass over the source: `clean` is the text with comments blanked, and
 * `inString[i]` is 1 when offset i lies inside a string / template literal
 * (so an `import … from '…'` written inside a string is not an import).
 */
function scan(text) {
  const inString = new Uint8Array(text.length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += i < text.length ? '  ' : '';
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          inString[i] = 1;
          if (i + 1 < text.length) inString[i + 1] = 1;
          i += 2;
          continue;
        }
        if (quote !== '`' && text[i] === '\n') break;
        inString[i] = 1;
        out += text[i];
        i++;
      }
      if (i < text.length) out += text[i++];
    } else {
      out += c;
      i++;
    }
  }
  return { clean: out, inString };
}

const PATTERNS = [
  // import x from '…' / import { a } from '…' / import type … from '…' / export … from '…'
  /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
  // import '…' (side effect)
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  // import('…') / require('…') / vi.mock-free dynamic loads
  /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

/** Every module specifier in `text`, with its 1-based line. */
export function parseImports(text) {
  const { clean, inString } = scan(text);
  const found = new Map();
  for (const pattern of PATTERNS) {
    for (const match of clean.matchAll(pattern)) {
      if (inString[match.index]) continue;
      const spec = match[2];
      const at = match.index + match[0].lastIndexOf(spec);
      const line = clean.slice(0, at).split('\n').length;
      found.set(`${line}:${spec}`, { line, specifier: spec });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** Why `specifier` imported from `file` breaks the rule, or null when it is allowed. */
export function importViolation(file, specifier) {
  const info = extensionFileInfo(file);
  if (!info) return null;
  if (specifier.startsWith('.')) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    const extensionsRoot = `apps/${info.app}/src/extensions/`;
    // Own directory, or another extension's directory (not the seam's own files).
    if (target.startsWith(extensionsRoot)) {
      const rest = target.slice(extensionsRoot.length);
      if (rest.includes('/')) return null;
      return `reaches the seam internals (${target}) — import from the kit instead`;
    }
    const kit = `apps/${info.app}/src/extension-kit`;
    if (target === kit || target.replace(/\.[cm]?[jt]sx?$/, '') === kit) return null;
    return `reaches into core (${target}) — use apps/${info.app}/src/extension-kit, or ask upstream to add it there`;
  }
  if (specifier.startsWith('/')) return 'absolute import path';
  if (specifier.startsWith('@greenhouse/')) {
    if (ALLOWED_PACKAGES.some((re) => re.test(specifier))) return null;
    return `internal package ${specifier} — use the kit (it re-exports the stable parts)`;
  }
  // `#…` subpath imports and workspace aliases would also be core.
  if (specifier.startsWith('#') || specifier.startsWith('~') || specifier.startsWith('@/')) {
    return `path alias ${specifier} — use the kit`;
  }
  return null; // third-party package or node builtin
}

/** Violations in one file's text: `[{ line, specifier, reason }]`. Test files are exempt. */
export function checkFileImports(file, text) {
  const info = extensionFileInfo(file);
  if (!info || info.test) return [];
  const out = [];
  for (const { line, specifier } of parseImports(text)) {
    const reason = importViolation(file, specifier);
    if (reason) out.push({ line, specifier, reason });
  }
  return out;
}
