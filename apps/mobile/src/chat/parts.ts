/**
 * What a message shows besides its words. React-free (./parts.test.ts).
 *
 * The server keeps a turn's tool steps, pictures and cited knowledge as JSON text on the
 * message (`pipeline`, `images`, `references_`); files a member attached ride in their message as
 * an ```attachments fence. From those this module derives:
 *
 *  - the member's bubble: the words without the fence, the pictures, the attached files;
 *  - the reply's cards (web parity, apps/web/src/components/tool-call/body-artifacts.tsx): an
 *    ask_user form, exported files, generated images, a task to save (task_capture), a table
 *    plan to apply (tables_schema_plan), cards of tools extensions add, and object cards for what
 *    the reply cites or the tools wrote (documents, tasks, projects, files);
 *  - the collapsed tool summary ("用了 3 个工具").
 */

import { objectId } from '../lib/object-id';

export interface ToolStep {
  /** A stable key within the reply. */
  id: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  status: 'running' | 'done' | 'failed';
}

export interface AttachedFile {
  id: string;
  name: string;
  size?: number;
}

export interface AskQuestion {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'single_choice' | 'multi_choice';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
}

export interface AskUser {
  title: string;
  description?: string;
  questions: AskQuestion[];
}

export interface TaskCapture {
  title: string;
  description?: string;
  content: string;
  variables: unknown[];
  expected_tools: string[];
  source_session_id?: string;
}

export interface SchemaPlan {
  summary: string;
  operations: unknown[];
}

/** An object a reply points at, as a card that opens its sheet. */
export interface CitedObject {
  type: 'doc' | 'task' | 'project' | 'file';
  id: string;
  title: string;
  projectId?: string;
}

export type ReplyCard =
  | { kind: 'ask_user'; key: string; ask: AskUser }
  | { kind: 'file'; key: string; id: string; name: string; size?: number; rows?: number; path: string }
  | { kind: 'image'; key: string; url: string; prompt?: string }
  | { kind: 'task_capture'; key: string; capture: TaskCapture; actionKey: string }
  | { kind: 'schema_plan'; key: string; plan: SchemaPlan; actionKey: string }
  | { kind: 'extension'; key: string; tool: string; title: string; summary?: string; url?: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

/** A JSON-text column (or an already parsed value) as an array; anything else is empty. */
export function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Pictures sent with a member's message. */
export function messageImages(images: unknown): { id: string; url: string }[] {
  return jsonArray(images).flatMap((raw) => {
    const item = record(raw);
    return item && typeof item.url === 'string' ? [{ id: String(item.id ?? item.url), url: item.url }] : [];
  });
}

const ATTACHMENTS = /```(?:mission-)?attachments[ \t]*\n([\s\S]*?)\n?```/g;

/** A member's words without the attachments fence, and the files it lists. */
export function splitAttachments(content: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = [];
  const text = content
    .replace(ATTACHMENTS, (_, body: string) => {
      for (const raw of jsonArray(body.trim())) {
        const item = record(raw);
        if (item && typeof item.id === 'string' && typeof item.name === 'string') {
          files.push({ id: item.id, name: item.name, ...(typeof item.size_bytes === 'number' ? { size: item.size_bytes } : {}) });
        }
      }
      return '';
    })
    .trim();
  return { text, files };
}

/** The attachments fence a member's message carries for files uploaded to its conversation. */
export function attachmentsFence(files: readonly AttachedFile[]): string {
  if (!files.length) return '';
  return '```attachments\n' + JSON.stringify(files.map((f) => ({ id: f.id, name: f.name, ...(f.size != null ? { size_bytes: f.size } : {}) }))) + '\n```';
}

/** A saved reply's tool steps. */
export function pipelineSteps(pipeline: unknown): ToolStep[] {
  return jsonArray(pipeline).flatMap((raw, index) => {
    const step = record(raw);
    if (!step || typeof step.tool !== 'string') return [];
    const output = step.output;
    const failed = !!record(output)?.error && !record(output)?.success;
    return [{ id: `p${typeof step.step === 'number' ? step.step : index}`, tool: step.tool, input: step.input, output, status: failed ? 'failed' : 'done' }];
  });
}

function askUser(output: Record<string, unknown>): AskUser | null {
  if (output.type !== 'ask_user' || !Array.isArray(output.questions)) return null;
  const questions = output.questions.flatMap((raw): AskQuestion[] => {
    const q = record(raw);
    if (!q || typeof q.id !== 'string' || typeof q.label !== 'string') return [];
    const type = q.type === 'textarea' || q.type === 'single_choice' || q.type === 'multi_choice' ? q.type : 'text';
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o) => {
          const opt = record(o);
          return opt && typeof opt.value === 'string' ? [{ value: opt.value, label: str(opt.label) ?? opt.value }] : [];
        })
      : undefined;
    return [{ id: q.id, label: q.label, type, ...(options ? { options } : {}), required: q.required === true, placeholder: str(q.placeholder) }];
  });
  return questions.length ? { title: str(output.title) ?? '', description: str(output.description), questions } : null;
}

/** The tools whose output is a card of their own (never also an extension card). */
const KNOWN_CARD_TYPES = new Set(['ask_user', 'file', 'task_capture', 'tables_schema_plan']);

/** The cards a reply shows for its tool steps (web parity; see the header). */
export function replyCards(steps: readonly ToolStep[], messageId: string, text: string): ReplyCard[] {
  const cards: ReplyCard[] = [];
  steps.forEach((step, index) => {
    const output = record(step.output);
    if (!output || step.status === 'running') return;
    const key = `${step.id}-${index}`;
    const actionKey = `artifact:${messageId}:${step.id.replace(/^p/, '') || index}:${step.tool}`;
    const ask = askUser(output);
    if (ask) {
      cards.push({ kind: 'ask_user', key, ask });
      return;
    }
    if (output.type === 'file' && typeof output.file_id === 'string' && typeof output.download_url === 'string') {
      if (/^\/api\/chat-files\//.test(output.download_url)) {
        cards.push({
          kind: 'file',
          key,
          id: output.file_id,
          name: str(output.name) ?? 'file',
          size: typeof output.size === 'number' ? output.size : undefined,
          rows: typeof output.row_count === 'number' ? output.row_count : undefined,
          path: output.download_url,
        });
      }
      return;
    }
    if (step.tool === 'generate_image' && output.success === true && typeof output.url === 'string') {
      // the reply's words already show the picture: no second copy (web parity)
      if (!text.includes(output.url)) cards.push({ kind: 'image', key, url: output.url, prompt: str(output.prompt) });
      return;
    }
    if (output.type === 'task_capture' && typeof output.content === 'string') {
      cards.push({
        kind: 'task_capture',
        key,
        actionKey,
        capture: {
          title: str(output.title) ?? '',
          description: str(output.description),
          content: output.content,
          variables: Array.isArray(output.variables) ? output.variables : [],
          expected_tools: Array.isArray(output.expected_tools) ? output.expected_tools.filter((t): t is string => typeof t === 'string') : [],
          source_session_id: str(output.source_session_id),
        },
      });
      return;
    }
    if (output.type === 'tables_schema_plan' && Array.isArray(output.operations)) {
      cards.push({ kind: 'schema_plan', key, actionKey, plan: { summary: str(output.summary) ?? '', operations: output.operations } });
      return;
    }
    // an extension's card: a typed output with a title (its own renderer lives on the web)
    if (typeof output.type === 'string' && !KNOWN_CARD_TYPES.has(output.type) && str(output.title) && !output.error) {
      cards.push({
        kind: 'extension',
        key,
        tool: step.tool,
        title: str(output.title)!,
        summary: str(output.summary) ?? str(output.description) ?? str(output.message),
        url: str(output.url),
      });
    }
  });
  return cards;
}

/** An id in a tool's output or a link (src/lib/object-id.ts); old outputs carry numbers. */
const positive = objectId;

/** Objects a tool wrote or read (`{ doc }`, `{ task }`, `{ project }`, `{ file }` in its output). */
function objectsIn(output: unknown): CitedObject[] {
  const out = record(output);
  if (!out) return [];
  const found: CitedObject[] = [];
  const doc = record(out.doc) ?? record(out.document);
  if (doc && positive(doc.id) && str(doc.title)) found.push({ type: 'doc', id: positive(doc.id)!, title: str(doc.title)! });
  const task = record(out.task);
  if (task && positive(task.id) && positive(task.project_id) && str(task.title)) {
    found.push({ type: 'task', id: positive(task.id)!, projectId: positive(task.project_id)!, title: str(task.title)! });
  }
  const project = record(out.project);
  if (project && positive(project.id) && str(project.title)) found.push({ type: 'project', id: positive(project.id)!, title: str(project.title)! });
  const file = record(out.file);
  if (file && positive(file.id) && str(file.name)) found.push({ type: 'file', id: positive(file.id)!, title: str(file.name)! });
  return found;
}

const DOC_URL = /#\/knowledge\/doc\/([A-Za-z0-9_]+)/;

/** What a reply cites (its knowledge references) and what its tools wrote, once each. */
export function citedObjects(references: unknown, steps: readonly ToolStep[]): CitedObject[] {
  const seen = new Set<string>();
  const out: CitedObject[] = [];
  const add = (object: CitedObject) => {
    const key = `${object.type}:${object.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(object);
  };
  for (const raw of jsonArray(references)) {
    const ref = record(raw);
    const id = positive(DOC_URL.exec(str(ref?.url) ?? '')?.[1]);
    if (ref && id && str(ref.title)) add({ type: 'doc', id, title: str(ref.title)! });
  }
  for (const step of steps) objectsIn(step.output).forEach(add);
  return out;
}

/**
 * The answer a member sends for an ask_user card — word for word what the web sends
 * (ask-user-card.tsx), in English on purpose: the model reads it, and the web recognises it.
 */
export function askUserAnswer(ask: AskUser, answers: Record<string, string | string[]>): string {
  const words = { intro: 'Here are my answers to your questions:', none: '(not answered)' };
  const lines = ask.questions.map((q, index) => {
    const raw = answers[q.id];
    const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v) => v.trim());
    const shown = values.map((value) => {
      const option = q.options?.find((o) => o.value === value);
      if (!option) return value;
      return option.label === option.value ? option.label : `${option.label} (${option.value})`;
    });
    return `**${index + 1}. ${q.label}**: ${shown.length ? shown.join(', ') : words.none}`;
  });
  return `${words.intro}\n\n${lines.join('\n')}`;
}
