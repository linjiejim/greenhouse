/**
 * A background task's running time, localized — the task dock's clock and
 * menu ("2m 31s" / "2分31秒") and its VoiceOver form ("2 minutes 31 seconds" /
 * "2 分钟 31 秒"). Pure and React-free (tested in ./task-elapsed.test.ts).
 *
 * The seconds and the unit steps are the web's `elapsed()`
 * (../vendor/web-helpers.ts — a verbatim copy pinned by the parity test, so it
 * isn't edited here). That one bakes in English unit letters; the phone
 * formats the same numbers through catalog keys (`bots.thread.elapsed.*`,
 * `bots.thread.elapsedA11y.*`). The test holds the English compact form equal
 * to the vendored string.
 */

import type { TranslationKey } from '../../lib/i18n';
import type { BotTaskView } from '../../shared/bots';

/** A catalog key and its numbers — render with `t(key, vars)`. */
export interface ElapsedText {
  key: TranslationKey;
  vars: Record<string, number>;
}

/** Whole seconds the task has run: from its start (else its creation) to its end (else `now`). */
export function taskSeconds(task: Pick<BotTaskView, 'created_at' | 'started_at' | 'ended_at'>, now: number): number {
  const start = Date.parse(task.started_at ?? task.created_at);
  const end = task.ended_at ? Date.parse(task.ended_at) : now;
  const seconds = Math.round((end - start) / 1000);
  // An unparseable timestamp reads as just started, not "NaNh NaNm".
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/** The short form for the screen: `{s}s` under a minute, `{m}m {s}s` under an hour, else `{h}h {m}m`. */
export function elapsedCompact(seconds: number): ElapsedText {
  if (seconds < 60) return { key: 'bots.thread.elapsed.s', vars: { s: seconds } };
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? { key: 'bots.thread.elapsed.ms', vars: { m: minutes, s: seconds % 60 } }
    : { key: 'bots.thread.elapsed.hm', vars: { h: Math.floor(minutes / 60), m: minutes % 60 } };
}

type Unit = 'second' | 'minute' | 'hour';

function part(n: number, unit: Unit): ElapsedText {
  const key: TranslationKey = n === 1 ? `bots.thread.elapsedA11y.${unit}` : `bots.thread.elapsedA11y.${unit}s`;
  return { key, vars: { n } };
}

/**
 * The spoken form, as parts to join with a space: the same two units as the
 * compact form with whole words (singular / plural), and a zero second unit
 * dropped ("2 minutes", not "2 minutes 0 seconds").
 */
export function elapsedSpoken(seconds: number): ElapsedText[] {
  if (seconds < 60) return [part(seconds, 'second')];
  const minutes = Math.floor(seconds / 60);
  const [major, minor]: [ElapsedText, number] =
    minutes < 60 ? [part(minutes, 'minute'), seconds % 60] : [part(Math.floor(minutes / 60), 'hour'), minutes % 60];
  if (minor === 0) return [major];
  return [major, part(minor, minutes < 60 ? 'second' : 'minute')];
}
