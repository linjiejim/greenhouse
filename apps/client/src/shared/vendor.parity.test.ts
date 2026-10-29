/**
 * Drift guards for the code the mobile app copies from the workspace. apps/client sits outside the
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
const MOBILE = 'apps/client/src';

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
  it('the public bootstrap shape matches packages/types/src/workspace-settings.ts', () => {
    const canonical = parse('packages/types/src/workspace-settings.ts');
    const copy = parse(`${MOBILE}/shared/greenhouse-types.ts`);
    for (const name of ['WorkspaceBootstrap', 'ThemeTokens']) {
      expect(declaration(copy, name), name).toBe(declaration(canonical, name));
    }
  });

  it('src/shared/push.ts is a verbatim copy of packages/types/src/push.ts', () => {
    expect(statementTexts(parse(`${MOBILE}/shared/push.ts`))).toEqual(
      statementTexts(parse('packages/types/src/push.ts')),
    );
  });

  it('src/shared/client-reports.ts is a verbatim copy of packages/types/src/client-reports.ts', () => {
    expect(statementTexts(parse(`${MOBILE}/shared/client-reports.ts`))).toEqual(
      statementTexts(parse('packages/types/src/client-reports.ts')),
    );
  });

  it('src/shared/client-routes.ts is a verbatim copy of packages/types/src/client-routes.ts', () => {
    expect(statementTexts(parse(`${MOBILE}/shared/client-routes.ts`))).toEqual(
      statementTexts(parse('packages/types/src/client-routes.ts')),
    );
  });

  it('src/shared/reports.ts is a verbatim copy of packages/types/src/reports.ts', () => {
    expect(statementTexts(parse(`${MOBILE}/shared/reports.ts`))).toEqual(
      statementTexts(parse('packages/types/src/reports.ts')),
    );
  });

  it('the skill upload limits match plugins/skills/api/skills/bundle.ts', () => {
    const canonical = parse('plugins/skills/api/skills/bundle.ts');
    const copy = parse(`${MOBILE}/plugins/skills/bundle.ts`);
    for (const name of ['MAX_FILES', 'MAX_BUNDLE_BYTES', 'MAX_PATH_LENGTH', 'SKILL_NAME_RE', 'PATH_SEGMENT_RE']) {
      expect(declaration(copy, name), name).toBe(declaration(canonical, name));
    }
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

  it('the automation tool catalog matches packages/types/src/automation-tools.ts', () => {
    const canonical = parse('packages/types/src/automation-tools.ts');
    const copy = parse(`${MOBILE}/shared/greenhouse-types.ts`);
    for (const name of ['AutomationOptInTier', 'AutomationOptInTool', 'CORE_OPT_IN_TOOLS']) {
      expect(declaration(copy, name), name).toBe(declaration(canonical, name));
    }
  });

  it('the connector sign-in message matches packages/types/src/connectors.ts', () => {
    const canonical = parse('packages/types/src/connectors.ts');
    const copy = parse(`${MOBILE}/shared/greenhouse-types.ts`);
    for (const name of ['CONNECTOR_CONNECT_MESSAGE_TYPE', 'ConnectorConnectMessage']) {
      expect(declaration(copy, name), name).toBe(declaration(canonical, name));
    }
  });

  it('the MCP consent groups match packages/types/src/mcp.ts', () => {
    const canonical = parse('packages/types/src/mcp.ts');
    const copy = parse(`${MOBILE}/shared/greenhouse-types.ts`);
    for (const name of ['MCP_RESOURCE_GROUP_IDS', 'RETIRED_MCP_RESOURCE_GROUP_IDS']) {
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
