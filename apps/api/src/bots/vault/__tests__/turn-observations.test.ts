import { describe, expect, it } from 'vitest';
import { foreignTurnReads, noteTurnObservation } from '../turn-observations.js';

const BANK = ['https://bank.example'];

describe('turn observation ledger', () => {
  it("is clean when the turn read only the entry's own site", () => {
    const turn = {};
    noteTurnObservation(turn, 'https://bank.example', false);
    noteTurnObservation(turn, 'https://bank.example', true);
    expect(foreignTurnReads(turn, BANK, true)).toBeNull();
  });

  it('lists every other site the turn read', () => {
    const turn = {};
    noteTurnObservation(turn, 'https://blog.example', false);
    noteTurnObservation(turn, 'https://bank.example', true);
    noteTurnObservation(turn, 'https://cdn.example', true);
    expect(foreignTurnReads(turn, BANK, true)).toEqual({
      origins: ['https://blog.example', 'https://cdn.example'],
      outside: false,
    });
    // Explicit subdomain patterns are honoured like the fill's own origin check.
    expect(foreignTurnReads(turn, ['https://bank.example', '*.example'], true)).toBeNull();
  });

  it('flags outside content with no origin (shell output, files, search, mail)', () => {
    const turn = {};
    noteTurnObservation(turn, 'https://bank.example', false);
    noteTurnObservation(turn, null, true);
    expect(foreignTurnReads(turn, BANK, true)).toEqual({ origins: [], outside: true });
  });

  it('flags a turn something else tainted before its first recorded read', () => {
    const tainted = {};
    noteTurnObservation(tainted, 'https://bank.example', true);
    expect(foreignTurnReads(tainted, BANK, true)).toEqual({ origins: [], outside: true });
    // Tainted with nothing recorded at all.
    expect(foreignTurnReads({}, BANK, true)).toEqual({ origins: [], outside: true });
    // Neither tainted nor read: nothing to fear.
    expect(foreignTurnReads({}, BANK, false)).toBeNull();
  });

  it('keeps turns apart', () => {
    const a = {};
    const b = {};
    noteTurnObservation(a, 'https://blog.example', false);
    noteTurnObservation(b, 'https://bank.example', false);
    expect(foreignTurnReads(a, BANK, true)).not.toBeNull();
    expect(foreignTurnReads(b, BANK, true)).toBeNull();
  });
});
