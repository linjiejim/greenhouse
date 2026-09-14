import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(process.cwd(), 'apps/web/src');
const COPY_ATTRIBUTES = new Set([
  'aria-label',
  'ariaLabel',
  'backLabel',
  'confirmLabel',
  'description',
  'downloadLabel',
  'label',
  'placeholder',
  'selectLabel',
  'title',
]);

const EXCLUDED_FILES = new Set([
  'pages/design.tsx',
  'pages/sprouty-lab.tsx',
  'components/sprouty/sprouty-geometric-concepts.tsx',
]);

// Product names, protocols, keyboard labels, units, and example values are not
// prose. Keeping this list narrow makes any new user-facing English fail here.
const INTENTIONAL_COPY = [
  /^(Greenhouse|by Greenhouse|Greenhouse|SkillHub|macOS|Windows|ESC|esc|PDF|KA|S\/A|ms|null)$/,
  /^(ID:|SN:|TTFB|client_id|sha256:)$/,
  /^(Greenhouse v|MB · \.|MB ·)$/,
  /^(IMAP|SMTP) (host|port)$/,
  /^(USD|EUR|GBP|CNY|JPY)$/,
  /^(L|W|H) \(cm\)$/,
  /^(https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+$|[a-z0-9.-]+\.com|[A-Z0-9][A-Z0-9-]+$)/,
  /^skillhub-sync$/,
  /^[a-z][a-z0-9_-]*(, [a-z][a-z0-9_-]*)+$/,
];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.') || entry.name.includes('.stories.')) return [];
    return [absolute];
  });
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isProse(value: string): boolean {
  const copy = normalized(value);
  if (/^&\w+;$/.test(copy)) return false;
  return /[A-Za-z]{2}/.test(copy) && !INTENTIONAL_COPY.some((pattern) => pattern.test(copy));
}

function visibleCopy(file: string): string[] {
  const relative = path.relative(SOURCE_ROOT, file);
  if (EXCLUDED_FILES.has(relative)) return [];
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const copy = normalized(node.text);
      if (isProse(copy))
        violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} text: ${copy}`);
    }
    if (ts.isJsxAttribute(node) && COPY_ATTRIBUTES.has(node.name.getText(source)) && node.initializer) {
      const initializer = node.initializer;
      const copy = ts.isStringLiteral(initializer) ? normalized(initializer.text) : '';
      if (isProse(copy)) {
        violations.push(
          `${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.name.getText(source)}: ${copy}`,
        );
      }
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const candidates: ts.Expression[] = [];
      if (ts.isStringLiteral(node.expression)) candidates.push(node.expression);
      if (ts.isConditionalExpression(node.expression)) {
        candidates.push(node.expression.whenTrue, node.expression.whenFalse);
      }
      if (ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        candidates.push(node.expression.right);
      }
      for (const candidate of candidates) {
        if (!ts.isStringLiteral(candidate) || !isProse(candidate.text)) continue;
        violations.push(
          `${relative}:${source.getLineAndCharacterOfPosition(candidate.getStart()).line + 1} expression: ${normalized(candidate.text)}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe('visible copy i18n guard', () => {
  it('does not add fixed English prose to production TSX', () => {
    expect(sourceFiles(SOURCE_ROOT).flatMap(visibleCopy)).toEqual([]);
  });
});
