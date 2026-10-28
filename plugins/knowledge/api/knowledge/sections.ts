/**
 * Markdown section addressing — the SINGLE implementation shared by the
 * knowledge read path (`knowledge_query` mode=outline|section) and the write
 * path (`knowledge_mutation` knowledge.update_section).
 *
 * Two implementations would mean a model can read "the section under this
 * heading", edit what it read, and write it back to a different span — the
 * failure is silent and only shows up as mangled documents. Both sides agree
 * here: a section runs from its heading to the next heading of the same or a
 * higher level (`level <= this one`), and a heading argument must match exactly
 * one heading or the call fails rather than guessing.
 */

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

interface KbHeading {
  /** 0-based line index of the heading line. */
  line: number;
  /** 1–6, from the number of leading '#'. */
  level: number;
  /** Heading text with the '#' prefix stripped. */
  text: string;
}

interface KbOutlineEntry extends Pick<KbHeading, 'level' | 'text'> {
  /** Characters in this section's body (excluding the heading line itself). */
  chars: number;
}

type KbSectionLocation =
  | { ok: true; heading: KbHeading; bodyStart: number; end: number }
  | { ok: false; error: string };

/** All headings in document order. */
function parseHeadings(markdown: string): KbHeading[] {
  const headings: KbHeading[] = [];
  markdown.split('\n').forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ line: i, level: m[1].length, text: m[2].trim() });
  });
  return headings;
}

/**
 * Locate the section a heading argument addresses. `headingArg` may carry its
 * own '#' prefix ("## Install") or not ("Install"). Ambiguity is an error, not
 * a guess: two identical headings in one doc are common (每个产品都有「规格参数」),
 * and silently picking the first one edits the wrong product.
 */
function locateSection(markdown: string, headingArg: string): KbSectionLocation {
  const target = headingArg.replace(/^#+\s*/, '').trim();
  if (!target) return { ok: false, error: 'heading is empty' };

  const lines = markdown.split('\n');
  const headings = parseHeadings(markdown);
  const matches = headings.filter((h) => h.text === target);
  if (matches.length === 0) {
    // Name the recovery, not just the failure (AGENTS: error text is prompt).
    const available = headings.map((h) => h.text).join(' / ') || '(no headings)';
    return { ok: false, error: `Heading not found: "${target}". Headings in this document: ${available}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `Heading "${target}" is not unique (${matches.length} matches)` };
  }

  const heading = matches[0];
  let end = lines.length;
  for (let i = heading.line + 1; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m && m[1].length <= heading.level) {
      end = i;
      break;
    }
  }
  return { ok: true, heading, bodyStart: heading.line + 1, end };
}

/**
 * Replace a single section's body, keeping the heading line. Used by
 * `knowledge_mutation`.
 */
export function replaceSection(
  markdown: string,
  headingArg: string,
  newBody: string,
): { ok: true; content: string } | { ok: false; error: string } {
  const found = locateSection(markdown, headingArg);
  if (!found.ok) return found;

  const lines = markdown.split('\n');
  const before = lines.slice(0, found.heading.line + 1); // through the heading line itself
  const after = lines.slice(found.end); // from the next heading onward
  const body = newBody.replace(/\n+$/, '').split('\n');
  const rebuilt = [...before, '', ...body, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n');
  return { ok: true, content: `${rebuilt.replace(/\s+$/, '')}\n` };
}

/**
 * Read one section (heading line + body) without loading the whole document.
 * Used by `knowledge_query` mode=section.
 */
export function readSection(
  markdown: string,
  headingArg: string,
): { ok: true; heading: string; level: number; content: string } | { ok: false; error: string } {
  const found = locateSection(markdown, headingArg);
  if (!found.ok) return found;
  const lines = markdown.split('\n');
  return {
    ok: true,
    heading: found.heading.text,
    level: found.heading.level,
    content: lines.slice(found.heading.line, found.end).join('\n').replace(/\s+$/, ''),
  };
}

/**
 * The document's heading tree with per-section body sizes, so a model can pick
 * what to read instead of pulling a 20k-character document into context.
 */
export function outlineSections(markdown: string): KbOutlineEntry[] {
  const lines = markdown.split('\n');
  const headings = parseHeadings(markdown);
  return headings.map((heading, i) => {
    // Body ends at the next heading of any level (an outline entry counts only
    // its own prose, not its subsections — those are their own entries).
    const end = headings[i + 1]?.line ?? lines.length;
    return {
      level: heading.level,
      text: heading.text,
      chars: lines
        .slice(heading.line + 1, end)
        .join('\n')
        .trim().length,
    };
  });
}
