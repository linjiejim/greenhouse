/**
 * Page snapshots for Bots — what a Bot "sees" of a web page, made safe before
 * it leaves the browser adapter.
 *
 * Playwright's AI snapshot (`page.ariaSnapshot({mode:'ai'})`) prints every
 * textbox's current VALUE — password, one-time-code and card fields included
 * (verified against Playwright 1.61). From a tool result that value would flow
 * into the transcript, the provider, other Bots' history and the digest. So
 * masking is structural, not best-effort:
 *
 * 1. In every frame (shadow roots included) collect the values of
 *    `input[type=password]`, inputs whose `autocomplete` names a credential or
 *    card field, and inputs whose name/id looks like pass/otp/cvc/cvv/pin —
 *    once before and once after taking the snapshot, so a value that changes
 *    in between is still known.
 * 2. In the snapshot, replace those values on textbox lines with
 *    `••• (n chars)`, mask textboxes whose accessible NAME says password/code/
 *    card (a backstop for fields the scan could not see), and mask every
 *    textbox value of a frame the scan could not reach.
 * 3. Replace the collected values anywhere else in the text (a site echoing a
 *    code back), never touching `[ref=…]` handles.
 * 4. Redact the computer's remembered secrets (vault fills, secure sign-ins,
 *    take-over typing) via `redactFilledSecrets`.
 * 5. Cap at ≈3k tokens: head + tail with a visible omission marker.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §5, design-review R6/R8.
 */

import type { Page } from 'playwright-core';
import { estimateTokens } from '@greenhouse/agent-core';
import { withTimeout } from './tab-leases.js';

export const SNAPSHOT_TOKEN_CAP = 3_000;
const LINE_CHAR_CAP = 2_000;
const MASK = '•••';

export interface SensitiveScan {
  /** Distinct non-empty values of sensitive inputs across all frames. */
  values: string[];
  /** The main frame could not be scanned — every textbox value gets masked. */
  mainFrameFailed: boolean;
  /** Some child frame could not be scanned — iframe textbox values get masked. */
  childFrameFailed: boolean;
}

/**
 * Runs inside the page (serialised by Playwright — must be self-contained).
 * Returns the values of credential-like inputs in this frame, shadow roots included.
 */
function collectInFrame(): string[] {
  const sensitiveAutocomplete = new Set([
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
  ]);
  const sensitiveName = /pass|otp|cvc|cvv|pin/i;
  // Common words that merely contain those letters (shipping, spinner…).
  const benign = /shipping|spinner|spinbutton|opinion|pinyin|pinterest|footprint|hotpot|compass/gi;
  const out: string[] = [];
  const visit = (root: Document | ShadowRoot) => {
    for (const input of Array.from(root.querySelectorAll('input'))) {
      const value = input.value;
      if (!value) continue;
      const type = (input.getAttribute('type') ?? '').toLowerCase();
      const tokens = (input.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
      const ident = `${input.name ?? ''} ${input.id ?? ''}`.replace(benign, '');
      if (type === 'password' || tokens.some((t) => sensitiveAutocomplete.has(t)) || sensitiveName.test(ident)) {
        out.push(value);
      }
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return out;
}

/** Scan every frame of a page for sensitive input values. */
export async function collectSensitiveValues(page: Page): Promise<SensitiveScan> {
  const values = new Set<string>();
  let mainFrameFailed = false;
  let childFrameFailed = false;
  const main = page.mainFrame();
  await Promise.all(
    page.frames().map(async (frame) => {
      try {
        for (const value of await withTimeout(frame.evaluate(collectInFrame), 3_000)) values.add(value);
      } catch {
        if (frame === main) mainFrameFailed = true;
        else if (!frame.isDetached()) childFrameFailed = true;
      }
    }),
  );
  return { values: [...values], mainFrameFailed, childFrameFailed };
}

export function mergeScans(a: SensitiveScan, b: SensitiveScan): SensitiveScan {
  return {
    values: [...new Set([...a.values, ...b.values])],
    mainFrameFailed: a.mainFrameFailed || b.mainFrameFailed,
    childFrameFailed: a.childFrameFailed || b.childFrameFailed,
  };
}

const TEXTBOX_LINE =
  /^(\s*- (?:textbox|searchbox|spinbutton|combobox)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]\n]*\])*)):(?: (.*))?$/;
const SENSITIVE_LABEL =
  /password|passcode|passwort|mot de passe|contraseña|密码|口令|one[- ]?time|\botp\b|2fa|verification code|security code|验证码|动态码|校验码|\bpin\b|cvv|cvc|card number|卡号|安全码/i;
const REF_TOKEN = /(\[ref=[^\]\n]*\])/;

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function maskFor(value: string): string {
  return `${MASK} (${[...value].length} chars)`;
}

/**
 * Mask sensitive values in an AI snapshot (pure; see the module comment).
 * Returns the masked text and how many values were hidden.
 */
export function maskSnapshot(snapshot: string, scan: SensitiveScan): { text: string; masked: number } {
  const sensitive = new Set(scan.values);
  let masked = 0;
  const lines = snapshot.split('\n').map((line) => {
    const match = TEXTBOX_LINE.exec(line);
    if (!match || match[4] === undefined || match[4] === '') return line;
    const [, head, name = '', attrs = ''] = match;
    const value = unquote(match[4]);
    const ref = /\[ref=([^\]]+)\]/.exec(attrs)?.[1] ?? '';
    const inChildFrame = /^f\d+e/.test(ref);
    const hide =
      sensitive.has(value) ||
      SENSITIVE_LABEL.test(name) ||
      scan.mainFrameFailed ||
      (scan.childFrameFailed && inChildFrame);
    if (!hide) return line;
    masked++;
    return `${head}: ${maskFor(value)}`;
  });

  // Values echoed elsewhere (page text, link names). Short values (a 3-digit
  // CVC) would shred unrelated text, so only distinctive ones are swept.
  const echoes = [...sensitive]
    .filter((v) => [...v].length >= 4)
    .flatMap((v) => {
      const escaped = JSON.stringify(v).slice(1, -1);
      return escaped === v ? [v] : [v, escaped];
    })
    .sort((a, b) => b.length - a.length);
  const text = lines
    .map((line) => {
      if (echoes.length === 0) return line;
      return line
        .split(REF_TOKEN)
        .map((part, i) => {
          if (i % 2 === 1) return part;
          let out = part;
          for (const value of echoes) {
            if (out.includes(value)) {
              out = out.split(value).join(MASK);
              masked++;
            }
          }
          return out;
        })
        .join('');
    })
    .join('\n');
  return { text, masked };
}

/**
 * Cap text at `maxTokens` (estimateTokens): the head (where the page's main
 * content and forms usually are) and the tail (footers, pagination), with a
 * visible marker in between so the Bot knows to scroll or narrow down.
 */
export function capSnapshot(
  text: string,
  maxTokens = SNAPSHOT_TOKEN_CAP,
  marker: (omittedLines: number) => string = pageOmission,
): { text: string; truncated: boolean } {
  const lines = text
    .split('\n')
    .map((line) => (line.length > LINE_CHAR_CAP ? `${line.slice(0, LINE_CHAR_CAP)}… [line truncated]` : line));
  const joined = lines.join('\n');
  if (estimateTokens(joined) <= maxTokens) return { text: joined, truncated: joined !== text };

  const headBudget = Math.floor(maxTokens * 0.7);
  const tailBudget = Math.floor(maxTokens * 0.22);
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > headBudget) break;
    head.push(line);
    used += cost;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const cost = estimateTokens(lines[i]!) + 1;
    if (used + cost > tailBudget) break;
    tail.unshift(lines[i]!);
    used += cost;
  }
  const omitted = lines.length - head.length - tail.length;
  return { text: [...head, marker(omitted), ...tail].join('\n'), truncated: true };
}

function pageOmission(omitted: number): string {
  return `… [${omitted} lines of the page omitted to save context — scroll, or click into the part you need, then snapshot again] …`;
}

export interface PageSnapshot {
  snapshot: string;
  truncated: boolean;
  masked: number;
}

/**
 * Take a safe snapshot of a page: scan → AI snapshot → scan → mask → redact →
 * cap. `redact` applies the computer's remembered-secret redaction.
 */
export async function takeSnapshot(page: Page, redact: (text: string) => string): Promise<PageSnapshot> {
  const before = await collectSensitiveValues(page);
  const raw = await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 });
  const after = await collectSensitiveValues(page);
  const { text, masked } = maskSnapshot(raw, mergeScans(before, after));
  const capped = capSnapshot(redact(text));
  return { snapshot: capped.text, truncated: capped.truncated, masked };
}
