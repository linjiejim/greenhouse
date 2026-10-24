/**
 * Drift guards for the code the mobile app copies from the workspace. apps/mobile sits outside the
 * pnpm workspace, so shared code arrives as verbatim copies; this ROOT vitest test (the mobile
 * tsconfig excludes *.test.ts) parses both sides with the repo's TypeScript and fails the moment
 * the canonical code changes without the copy following.
 *
 * - File verbatim: every statement after the imports (JSDoc included) is identical.
 * - Declarations verbatim: named top-level declarations, compared without `export` and with
 *   whitespace normalised (hand-kept subsets such as ./greenhouse-types.ts).
 *
 * When one fails: re-copy the canonical file or declaration into the mobile copy, never edit the
 * copy by hand.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const MOBILE = 'apps/mobile/src';

function parse(path: string): ts.SourceFile {
  const text = readFileSync(resolve(ROOT, path), 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every statement after the imports, with its JSDoc. */
function statementTexts(sf: ts.SourceFile): string[] {
  return sf.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => sf.text.slice(statement.getStart(sf, true), statement.end));
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) => declaration.name.getText());
  }
  if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    return statement.name ? [statement.name.text] : [];
  }
  return [];
}

function declaration(sf: ts.SourceFile, name: string): string {
  const found = sf.statements.find((statement) => declaredNames(statement).includes(name));
  if (!found) throw new Error(`${sf.fileName} declares no top-level ${name}`);
  return found
    .getText(sf)
    .replace(/^export\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('vendored workspace code', () => {
  it('src/shared/push.ts is a verbatim copy of packages/types/src/push.ts', () => {
    expect(statementTexts(parse(`${MOBILE}/shared/push.ts`))).toEqual(
      statementTexts(parse('packages/types/src/push.ts')),
    );
  });

  it('the connected-agent plant rule matches packages/types/src/plant-avatar.ts', () => {
    const canonical = parse('packages/types/src/plant-avatar.ts');
    const copy = parse(`${MOBILE}/ui/plant-avatar/plant-ids.ts`);
    for (const name of ['CLIENT_PLANTS', 'CLIENT_POOL', 'ClientPlant', 'plantForClient', 'avatarTint', 'hashSeed']) {
      expect(declaration(copy, name), name).toBe(declaration(canonical, name));
    }
  });

  it('the notification shapes match packages/types/src/notification.ts', () => {
    const canonical = parse('packages/types/src/notification.ts');
    const copy = parse(`${MOBILE}/shared/greenhouse-types.ts`);
    for (const name of ['PlatformNotificationKind', 'PlatformNotificationList', 'PlatformNotificationSummary']) {
      expect(declaration(copy, name), name).toBe(declaration(canonical, name));
    }
  });

  it('the stations config shapes match packages/types/src/config.ts', () => {
    const canonical = parse('packages/types/src/config.ts');
    const copy = parse(`${MOBILE}/shared/greenhouse-config.ts`);
    for (const name of ['StationConfig', 'ClientStationsConfig']) {
      expect(declaration(copy, name), name).toBe(declaration(canonical, name));
    }
  });
});
