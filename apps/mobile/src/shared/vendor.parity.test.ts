/**
 * Drift guards for the code the mobile app copies from the workspace. apps/mobile sits outside the
 * pnpm workspace, so shared code arrives as verbatim copies; this ROOT vitest test (the mobile
 * tsconfig excludes *.test.ts) parses both sides with the repo's TypeScript and fails the moment
 * the canonical code changes without the copy following.
 *
 * - File verbatim: every statement after the imports (JSDoc included) is identical; only import
 *   paths differ.
 * - Declarations verbatim: named top-level declarations, compared without `export` and with
 *   whitespace normalised.
 *
 * The API contract has its own generator and guard (./contract.parity.test.ts), and so does the
 * Rich Output module (./rich-output.parity.test.ts). When one fails: re-copy the canonical file or
 * declaration into the mobile copy, never edit the copy by hand.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { avatarConfigSchema } from '@greenhouse/types/profile-manifest';

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

function expectFileVendored(canonical: string, copy: string) {
  expect(statementTexts(parse(copy)), `${copy} is not a verbatim copy of ${canonical}; re-copy it`).toEqual(
    statementTexts(parse(canonical)),
  );
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

function declaration(sf: ts.SourceFile, name: string): ts.Statement {
  const found = sf.statements.find((statement) => declaredNames(statement).includes(name));
  if (!found) throw new Error(`${sf.fileName} declares no top-level ${name}`);
  return found;
}

const normalise = (text: string) => text.replace(/\s+/g, ' ').trim();

function declarationText(sf: ts.SourceFile, name: string): string {
  return normalise(
    declaration(sf, name)
      .getText(sf)
      .replace(/^export\s+/, ''),
  );
}

describe('file-verbatim copies', () => {
  it('plant-avatar vocabulary and resolver', () => {
    expectFileVendored('packages/types/src/plant-avatar.ts', `${MOBILE}/ui/plant-avatar/plant-ids.ts`);
  });

  it('Agent templates', () => {
    expectFileVendored('packages/types/src/agent-templates.ts', `${MOBILE}/shared/agent-templates.ts`);
  });
});

describe('declaration-verbatim copies', () => {
  it('legacy avatar id tables (avatar-config.ts)', () => {
    const [from, to] = [parse('packages/types/src/profile-manifest.ts'), parse(`${MOBILE}/ui/plant-avatar/avatar-config.ts`)];
    for (const name of [
      'SPROUTY_COLOR_IDS',
      'SproutyColorId',
      'SPROUTY_ACCESSORY_IDS',
      'SproutyAccessoryId',
      'SPROUTY_LEAF_STYLE_IDS',
      'SproutyLeafStyleId',
      'SPROUTY_FACE_STYLE_IDS',
      'SproutyFaceStyleId',
    ]) {
      expect(declarationText(to, name), `avatar-config.ts: ${name} differs; re-copy it`).toBe(declarationText(from, name));
    }
  });

  it('AvatarConfig spells out the zod schema (same keys, all optional)', () => {
    const sf = parse(`${MOBILE}/ui/plant-avatar/avatar-config.ts`);
    const config = declaration(sf, 'AvatarConfig') as ts.InterfaceDeclaration;
    const members = config.members.filter(ts.isPropertySignature);
    expect(members.map((member) => member.name.getText(sf)).sort()).toEqual(Object.keys(avatarConfigSchema.shape).sort());
    expect(members.every((member) => member.questionToken)).toBe(true);
  });
});
