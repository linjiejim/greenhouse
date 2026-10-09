/**
 * The engine's taint backstop: outside-content tools taint the turn, the
 * computer's `import_attachment` (a copy the Bot never reads) does not, and an
 * outside source other than the browser/computer is noted in the vault's
 * foreign-read ledger.
 */

import { describe, expect, it } from 'vitest';
import { foreignTurnReads, noteTurnObservation } from '../../vault/turn-observations.js';
import { observeToolResult, resultTaintsTurn } from '../taint.js';

describe('resultTaintsTurn', () => {
  it('taints on outside content: pages, shell output, search, mail, attachments, images', () => {
    expect(resultTaintsTurn('browser', { action: 'snapshot' })).toBe(true);
    expect(resultTaintsTurn('computer', { action: 'shell', command: 'cat x' })).toBe(true);
    expect(resultTaintsTurn('computer', { action: 'read_file', path: 'x' })).toBe(true);
    for (const tool of ['external_search', 'email_query', 'read_attachment', 'analyze_image']) {
      expect(resultTaintsTurn(tool, {})).toBe(true);
    }
  });

  it("taints on every external connector action — a remote tool's description is the remote side's words too", () => {
    for (const action of ['list', 'describe', 'call']) {
      expect(resultTaintsTurn('mcp_call', { action, server: 'linear', tool: 'list_issues' })).toBe(true);
    }
  });

  it('does not taint on an import_attachment copy, or on Greenhouse reads', () => {
    expect(resultTaintsTurn('computer', { action: 'import_attachment', file_id: 'f1' })).toBe(false);
    expect(resultTaintsTurn('knowledge_query', { query: 'q' })).toBe(false);
    expect(resultTaintsTurn('memory', { action: 'recall' })).toBe(false);
  });

  it('fails closed when a computer call has no readable action', () => {
    expect(resultTaintsTurn('computer', undefined)).toBe(true);
    expect(resultTaintsTurn('computer', 'import_attachment')).toBe(true);
    expect(resultTaintsTurn('computer', { action: 42 })).toBe(true);
  });
});

describe('observeToolResult and the vault foreign-read ledger', () => {
  const bank = ['https://bank.example'];

  it('a search or an email read after the entry’s own page makes a later fill ask', () => {
    const turn = {};
    // The browser read the bank's sign-in page first (it records its own origin).
    noteTurnObservation(turn, 'https://bank.example', false);
    expect(observeToolResult(turn, 'browser', { action: 'snapshot' }, false)).toBe(true);
    expect(foreignTurnReads(turn, bank, true)).toBeNull();
    // Then an email the Bot read could be steering the fill.
    expect(observeToolResult(turn, 'email_query', { action: 'read' }, true)).toBe(true);
    expect(foreignTurnReads(turn, bank, true)).toEqual({ origins: [], outside: true });
  });

  it('leaves the ledger to the browser and computer, and ignores non-tainting tools', () => {
    const turn = {};
    noteTurnObservation(turn, 'https://bank.example', false);
    expect(observeToolResult(turn, 'computer', { action: 'shell' }, false)).toBe(true);
    expect(observeToolResult(turn, 'knowledge_query', {}, true)).toBe(false);
    expect(foreignTurnReads(turn, bank, true)).toBeNull();
  });
});
