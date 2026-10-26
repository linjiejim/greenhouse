/**
 * Dates and timestamps, masked out before the sensitive sweep runs.
 *
 * `2026-08-11` is eight digits joined by separators — which is also exactly what
 * a phone number written without a country code looks like, so the phone pattern
 * used to swallow it. Recording WHEN something was decided is the most ordinary
 * thing a memory does, and on dev it cost six consecutive refusals of a memory
 * whose only "phone number" was the date the work started (2026-08-13). The
 * model has no way to see which fragment offended, so it retries verbatim.
 *
 * Dates are excluded by position rather than by making the phone pattern
 * cleverer: a date is unambiguous on its own, while "is this digit run a phone
 * number" is only answerable once the dates are out of the way.
 */
const DATE_LIKE =
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g;

/**
 * A run of digits grouped by the separators phone numbers actually use. The
 * shape alone is not the verdict — `findSensitiveSpans` also requires
 * `PHONE_MIN_DIGITS`..`PHONE_MAX_DIGITS` digits, which is what keeps compact
 * dates (`20260811`), years and order counts out. No dialable number is shorter
 * than that once an area or country code is included, and none is longer (E.164).
 */
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,22}\d/g;
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

interface SensitiveSpan {
  start: number;
  end: number;
  label: string;
}

/** Character spans holding a date, which no sensitive pattern may claim. */
function dateSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(DATE_LIKE)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Every sensitive match in `text`, minus anything overlapping a date.
 *
 * Both callers share this so a rejection and a redaction can never disagree
 * about what counts as sensitive — the friction evidence for a refused memory
 * has to show the same fragments the refusal was about.
 */
export function findSensitiveSpans(text: string): SensitiveSpan[] {
  const dates = dateSpans(text);
  const spans: SensitiveSpan[] = [];

  for (const { label, re } of SENSITIVE_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      // A phone-shaped run that IS a date (or sits inside one) is a date.
      if (dates.some((d) => start < d.end && end > d.start)) continue;
      if (re === PHONE_PATTERN) {
        const digits = match[0].match(/\d/g)?.length ?? 0;
        if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) continue;
      }
      spans.push({ start, end, label });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Patterns that must never be persisted into a memory. The prompt asks the model
 * not to; this is the part that actually enforces it — memories are replayed at
 * the top of every future conversation, so one leaked secret leaks forever.
 */
const SENSITIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'an email address', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { label: 'a phone number', re: PHONE_PATTERN },
  { label: 'an API key or token', re: /\b(?:sk|pk|lpai|lpct|lpoa|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi },
  { label: 'a JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'a long hex secret', re: /\b[0-9a-f]{32,}\b/gi },
  { label: 'a password', re: /\b(?:password|passwd|secret|api[_\s-]?key)\s*[:=]\s*\S+/gi },
];

/**
 * Strip anything secret-shaped out of friction evidence. Frictions are raw tool
 * I/O excerpts, so unlike memories they are redacted rather than rejected —
 * dropping the whole sample would throw away the diagnostic value.
 */
export function redactEvidence(text: string): string {
  const spans = findSensitiveSpans(text);
  if (spans.length === 0) return text;

  // Right to left so each splice leaves earlier offsets valid, and skip spans
  // already covered by one applied to their right (two patterns can overlap).
  let out = text;
  let boundary = text.length;
  for (const span of [...spans].reverse()) {
    if (span.end > boundary) continue;
    out = `${out.slice(0, span.start)}[redacted]${out.slice(span.end)}`;
    boundary = span.start;
  }
  return out;
}
