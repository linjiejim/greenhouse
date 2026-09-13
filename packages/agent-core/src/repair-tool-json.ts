/**
 * Salvaging tool-call arguments that arrived as not-quite-JSON.
 *
 * Models emit tool arguments as a JSON string, and on long payloads they get it
 * wrong in a small number of recurring ways — an unescaped quote inside a value,
 * a raw newline in a string, a trailing comma, output cut off mid-structure.
 * The SDK's parse then fails and the whole call is lost. On dev this cost a user
 * their workflow outright: three consecutive `workflow_plan` drafts carrying
 * long multi-line Chinese briefs died at `Expected ',' or '}' after property
 * value`, and the model gave up on orchestration and did the work by hand.
 *
 * This repairs the text locally rather than asking a model to fix it: the
 * failure is mechanical, a second round-trip costs seconds and can fail again,
 * and a deterministic repair is something tests can actually pin.
 *
 * These are HEURISTICS, and they are only ever reached after a genuine parse
 * failure — never on the happy path. The quote rule in particular can guess
 * wrong on a value that really does contain `", ` mid-sentence; the result is
 * then either a still-invalid parse (caller falls back, as before) or a value
 * whose quoting differs slightly from what the model intended. Both beat
 * discarding the call.
 *
 * That known wrong guess is why there are two passes. On dev it cost a user a
 * 4-item `tables_mutation` batch: a value contained `", ` mid-sentence, the
 * loose rule ended the string there, and the prose after the comma landed where
 * a key must be — `Expected double-quoted property name`, twice, until the user
 * gave up and sent the items one per call. The strict pass only ends a string
 * at `", ` when what follows the comma actually starts a JSON value, which is
 * what a real key/element boundary looks like.
 *
 * The passes are ordered loose-then-strict and the strict result is used ONLY
 * when it parses, so this can never turn a repairable payload into a lost one —
 * it only converts `null` (call discarded) into a salvaged call.
 */

/** Characters that may legally follow the closing quote of a JSON string. */
const CLOSERS = new Set([',', '}', ']', ':']);

/** Literals that may begin a JSON value, for the strict pass's comma check. */
const VALUE_LITERALS = ['true', 'false', 'null'];

/**
 * Does a JSON value plausibly start at `raw[from]`?
 *
 * Used only by the strict pass, to tell a real `", "` boundary (the next thing
 * is a key or an array element) from prose that merely contains `", `.
 */
function startsJsonValue(raw: string, from: number): boolean {
  let i = from;
  while (i < raw.length && /\s/.test(raw[i]!)) i++;
  const ch = raw[i];
  if (ch === undefined) return false;
  if (ch === '"' || ch === '{' || ch === '[' || ch === '-') return true;
  if (ch >= '0' && ch <= '9') return true;
  return VALUE_LITERALS.some((literal) => raw.startsWith(literal, i));
}

function escapeControlChar(ch: string): string {
  switch (ch) {
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    default:
      return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }
}

/**
 * Return a parseable version of `raw`, or null if it cannot be salvaged.
 *
 * Valid input is returned unchanged, so this is safe to call unconditionally.
 */
export function repairJsonArguments(raw: string): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // fall through to repair
  }

  return rewrite(raw, false) ?? rewrite(raw, true);
}

/**
 * One repair pass. `strict` changes exactly one decision: whether a quote
 * followed by a comma ends the string (see the module header).
 *
 * Returns null when the rewritten text still does not parse.
 */
function rewrite(raw: string, strict: boolean): string | null {
  let out = '';
  let inString = false;
  let escaped = false;
  /** Open `{` / `[` in order, so a truncated payload can be closed correctly. */
  const stack: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;

    if (!inString) {
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
      out += ch;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      // A quote ends the string only if what follows it could follow a value.
      // Anything else means the model wrote a quote inside its prose and never
      // escaped it — the single most common way a long brief breaks.
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      const next = raw[j];
      // `", ` is the ambiguous one: it ends a real key/element boundary just as
      // often as it sits mid-sentence. The strict pass keeps the string open
      // unless a JSON value actually starts after the comma.
      const closes =
        next === undefined ? true : strict && next === ',' ? startsJsonValue(raw, j + 1) : CLOSERS.has(next);
      if (closes) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }

    // Raw control characters are illegal inside a JSON string; models paste
    // real newlines into multi-line briefs constantly.
    out += ch.charCodeAt(0) < 0x20 ? escapeControlChar(ch) : ch;
  }

  // Truncated output: close the string, then every container still open.
  if (inString) out += '"';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';

  // Trailing commas, including ones just exposed by closing a truncated object.
  out = out.replace(/,(\s*[}\]])/g, '$1');

  try {
    JSON.parse(out);
    return out;
  } catch {
    return null;
  }
}
