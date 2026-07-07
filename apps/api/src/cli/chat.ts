#!/usr/bin/env tsx
/**
 * `cli chat` — interactive chat with the agent (a `pnpm cli` subcommand; the
 * standalone `pnpm chat` alias still works). Unlike the other commands this one
 * talks to a running API over HTTP, so start the server first (`pnpm api`).
 *
 * Usage:
 *   pnpm cli chat                   Start new session (default profile)
 *   pnpm cli chat --profile <id>    Start with a specific profile
 *   pnpm cli chat --session <id>    Resume existing session
 *   pnpm cli chat --list            List recent sessions
 *   pnpm cli chat --api http://...  Custom API endpoint
 */

import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { createInternalToken, isAuthEnabled } from '../auth/index.js';
import { getProductName } from '@greenhouse/utils/brand';

// Configure marked for terminal rendering
marked.use(
  markedTerminal({
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 100) - 4,
    tab: 2,
  }) as Parameters<typeof marked.use>[0],
);

const API_BASE = process.argv.includes('--api')
  ? process.argv[process.argv.indexOf('--api') + 1]
  : (process.env.API_BASE ?? 'http://localhost:3000');

// ─── Tool Call State ─────────────────────────────────────

interface ToolCallState {
  id: string;
  name: string;
  inputJson: string;
}

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

// ─── Session Types ───────────────────────────────────────

interface Session {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// ─── Auth Headers ────────────────────────────────────────

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isAuthEnabled()) {
    headers['Authorization'] = `Bearer ${createInternalToken()}`;
  }
  return headers;
}

// Track local messages for display (API handles persistence)
const localMessages: Array<{ role: string; content: string }> = [];

// ─── Markdown Rendering ──────────────────────────────────

function renderMarkdown(text: string): string {
  try {
    let rendered = marked(text) as string;
    rendered = rendered
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n');
    return rendered;
  } catch {
    return text
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n');
  }
}

// ─── Session API Helpers ─────────────────────────────────

async function createSessionApi(profileId?: string): Promise<Session> {
  const resp = await fetch(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ profile_id: profileId }),
  });
  return (await resp.json()) as Session;
}

async function listSessionsApi(): Promise<Session[]> {
  const resp = await fetch(`${API_BASE}/api/sessions?limit=10`, {
    headers: getAuthHeaders(),
  });
  const data = (await resp.json()) as { sessions: Session[] };
  return data.sessions;
}

async function getSessionApi(id: string): Promise<{
  session: Session;
  messages: Array<{ role: string; content: string }>;
  usage: Record<string, number>;
} | null> {
  const resp = await fetch(`${API_BASE}/api/sessions/${id}`, {
    headers: getAuthHeaders(),
  });
  if (!resp.ok) return null;
  return (await resp.json()) as {
    session: Session;
    messages: Array<{ role: string; content: string }>;
    usage: Record<string, number>;
  };
}

// ─── Stream Chat ─────────────────────────────────────────

async function streamChat(sessionId: string, userMessage: string): Promise<string> {
  localMessages.push({ role: 'user', content: userMessage });

  const startTime = Date.now();

  const resp = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      session_id: sessionId,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(chalk.red(`\n  ❌ API Error ${resp.status}: ${text}\n`));
    localMessages.pop();
    return '';
  }

  if (!resp.body) {
    console.error(chalk.red('\n  ❌ No response body\n'));
    localMessages.pop();
    return '';
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();

  let fullText = '';
  let buffer = '';
  const activeToolCalls = new Map<string, ToolCallState>();
  let inReasoning = false;
  let usage: UsageInfo | null = null;

  process.stdout.write('\n');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      switch (event.type) {
        case 'text-delta': {
          fullText += event.text as string;
          break;
        }

        case 'reasoning-delta': {
          if (!inReasoning) {
            inReasoning = true;
            process.stdout.write(chalk.dim.yellow('  💭 '));
          }
          process.stdout.write(chalk.dim.yellow(event.text as string));
          break;
        }

        case 'tool-call-start': {
          if (inReasoning) {
            process.stdout.write('\n');
            inReasoning = false;
          }
          const id = event.id as string;
          const toolName = event.toolName as string;
          activeToolCalls.set(id, { id, name: toolName, inputJson: '' });
          process.stdout.write(chalk.cyan(`  ${getToolIcon(toolName)} [${toolName}] `));
          break;
        }

        case 'tool-call-delta': {
          const tc = activeToolCalls.get(event.id as string);
          if (tc) tc.inputJson += event.delta as string;
          break;
        }

        case 'tool-call-end': {
          const tc = activeToolCalls.get(event.id as string);
          if (tc) {
            process.stdout.write(chalk.gray(summarizeToolInput(tc.name, tc.inputJson)) + '\n');
          }
          break;
        }

        case 'tool-result': {
          const id = event.id as string;
          const tc = activeToolCalls.get(id);
          const toolName = (event.toolName as string) || tc?.name || 'unknown';
          process.stdout.write(chalk.gray(`     ↳ ${summarizeToolOutput(toolName, event.output)}`) + '\n');
          activeToolCalls.delete(id);
          break;
        }

        case 'step-start': {
          if (inReasoning) {
            process.stdout.write('\n');
            inReasoning = false;
          }
          break;
        }

        case 'finish': {
          const u = event.totalUsage as Record<string, unknown> | undefined;
          if (u) {
            usage = {
              inputTokens: (u.inputTokens as number) ?? 0,
              outputTokens: (u.outputTokens as number) ?? 0,
              cachedInputTokens: (u.cachedInputTokens as number) ?? 0,
              reasoningTokens: (u.reasoningTokens as number) ?? 0,
            };
          }
          break;
        }

        case 'error':
          console.error(chalk.red(`\n  ❌ Error: ${event.error}\n`));
          break;

        default:
          break;
      }
    }
  }

  if (inReasoning) process.stdout.write('\n');

  // Render markdown
  if (fullText) {
    process.stdout.write('\n');
    process.stdout.write(renderMarkdown(fullText));
  }

  // Usage stats
  const elapsed = Date.now() - startTime;
  const parts: string[] = [];
  if (usage) {
    const cached = usage.cachedInputTokens > 0 ? ` (${usage.cachedInputTokens} cached)` : '';
    parts.push(`${usage.inputTokens} in${cached}`);
    if (usage.reasoningTokens > 0) parts.push(`${usage.reasoningTokens} reasoning`);
    parts.push(`${usage.outputTokens} out`);
  }
  parts.push(`${(elapsed / 1000).toFixed(1)}s`);
  process.stdout.write(chalk.dim(`  ⚡ ${parts.join(' · ')}\n`));
  process.stdout.write('\n');

  if (fullText) {
    localMessages.push({ role: 'assistant', content: fullText });
  }

  return fullText;
}

// ─── Display Helpers ─────────────────────────────────────

function getToolIcon(toolName: string): string {
  switch (toolName) {
    case 'search':
      return '🔍';
    case 'get_page':
      return '📖';
    default:
      return '🔧';
  }
}

function summarizeToolInput(toolName: string, inputJson: string): string {
  try {
    const input = JSON.parse(inputJson);
    switch (toolName) {
      case 'search':
        return `searching "${input.query}"${input.category && input.category !== 'all' ? ` in ${input.category}` : ''}`;
      case 'get_page':
        return `reading ${input.slug}`;
      default:
        return inputJson.slice(0, 80);
    }
  } catch {
    return inputJson.slice(0, 80) || '...';
  }
}

function summarizeToolOutput(toolName: string, output: unknown): string {
  try {
    const r = output as Record<string, unknown>;
    switch (toolName) {
      case 'search': {
        const wikiPages = (r.wiki_pages as unknown[]) ?? [];
        const sources = (r.source_docs as unknown[]) ?? [];
        const total = wikiPages.length + sources.length;
        if (total === 0) return 'No results found';
        const titles = [...wikiPages, ...sources].slice(0, 3).map((item: unknown) => (item as { title: string }).title);
        return `Found ${total}: ${titles.join(', ')}${total > 3 ? '...' : ''}`;
      }
      case 'get_page': {
        if (r.error) return `Error: ${r.error}`;
        return `Loaded "${r.title}" (${((r.content as string) ?? '').length} chars)`;
      }
      default:
        return JSON.stringify(output).slice(0, 100);
    }
  } catch {
    return '(result received)';
  }
}

// ─── Main ────────────────────────────────────────────────

async function checkHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/health`);
    if (!resp.ok) return false;
    const data = (await resp.json()) as Record<string, unknown>;
    console.log(chalk.gray(`  Server: ${API_BASE}`));
    console.log(chalk.gray(`  Model:  ${data.model}`));
    console.log(chalk.gray(`  Wiki:   ${data.wiki_pages} pages, ${data.sources} sources`));
    return true;
  } catch {
    return false;
  }
}

export async function run(_args: string[]): Promise<number> {
  // ── Handle --list ──
  if (process.argv.includes('--list')) {
    console.log(chalk.green.bold('\n  🌱 Recent Sessions'));
    const healthy = await checkHealth().catch(() => false);
    if (!healthy) {
      console.error(chalk.red(`  ❌ Cannot connect to ${API_BASE}\n`));
      return 1;
    }
    const sessions = await listSessionsApi();
    if (sessions.length === 0) {
      console.log(chalk.gray('  No sessions found.\n'));
    } else {
      for (const s of sessions) {
        const date = new Date(s.updated_at).toLocaleString();
        const title = s.title ?? '(untitled)';
        console.log(chalk.gray(`  ${s.id.slice(0, 8)}  ${date}  ${title}`));
      }
      console.log('');
    }
    return 0;
  }

  console.log(chalk.green.bold(`\n  🌱 ${getProductName()} Chat`));
  console.log(chalk.gray('  ─'.repeat(25)));

  const healthy = await checkHealth();
  if (!healthy) {
    console.error(chalk.red(`\n  ❌ Cannot connect to API at ${API_BASE}`));
    console.error(chalk.gray('  Start the server first: pnpm api\n'));
    return 1;
  }

  // ── Resolve session ──
  let sessionId: string;
  const resumeIdx = process.argv.indexOf('--session');
  const profileIdx = process.argv.indexOf('--profile');
  const profileId = profileIdx !== -1 ? process.argv[profileIdx + 1] : undefined;

  if (resumeIdx !== -1 && process.argv[resumeIdx + 1]) {
    // Resume existing session
    const id = process.argv[resumeIdx + 1];
    const data = await getSessionApi(id);
    if (!data) {
      console.error(chalk.red(`\n  ❌ Session not found: ${id}\n`));
      return 1;
    }
    sessionId = data.session.id;
    const msgCount = data.messages.length;
    const title = data.session.title ?? '(untitled)';
    console.log(chalk.gray(`\n  Resumed session: ${sessionId.slice(0, 8)}... "${title}" (${msgCount} messages)`));

    // Load existing messages into local state
    for (const m of data.messages) {
      localMessages.push({ role: m.role, content: m.content });
    }

    // Show usage summary
    const u = data.usage;
    if (u.messageCount > 0) {
      console.log(
        chalk.dim(
          `  Session totals: ${u.totalInputTokens} in · ${u.totalOutputTokens} out · ${(u.totalDurationMs / 1000).toFixed(1)}s`,
        ),
      );
    }
  } else {
    // Create new session with optional profile
    const session = await createSessionApi(profileId);
    sessionId = session.id;
    const profileLabel = profileId ? ` (profile: ${profileId})` : '';
    console.log(chalk.gray(`\n  New session: ${sessionId.slice(0, 8)}...${profileLabel}`));
  }

  console.log(chalk.gray('  Commands: /clear, /history, /sessions, /info, /quit'));
  console.log(chalk.gray('  ─'.repeat(25)) + '\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    let input: string;
    try {
      input = await rl.question(chalk.blue('  You: '));
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed === '/quit' || trimmed === '/exit' || trimmed === '/q') break;

    if (trimmed === '/clear') {
      localMessages.length = 0;
      // Create a fresh session with same profile
      const session = await createSessionApi(profileId);
      sessionId = session.id;
      console.log(chalk.gray(`  (new session: ${sessionId.slice(0, 8)}...)\n`));
      continue;
    }

    if (trimmed === '/history') {
      console.log(chalk.gray(`  ${localMessages.length} messages in session ${sessionId.slice(0, 8)}...\n`));
      for (const msg of localMessages) {
        const prefix = msg.role === 'user' ? '  👤' : '  🤖';
        console.log(chalk.gray(`  ${prefix} ${msg.content.slice(0, 60)}${msg.content.length > 60 ? '...' : ''}`));
      }
      console.log('');
      continue;
    }

    if (trimmed === '/sessions') {
      const sessions = await listSessionsApi();
      console.log(chalk.gray(`\n  Recent sessions:`));
      for (const s of sessions) {
        const marker = s.id === sessionId ? chalk.green('→') : ' ';
        const date = new Date(s.updated_at).toLocaleString();
        const title = s.title ?? '(untitled)';
        console.log(chalk.gray(`  ${marker} ${s.id.slice(0, 8)}  ${date}  ${title}`));
      }
      console.log('');
      continue;
    }

    if (trimmed === '/info') {
      const data = await getSessionApi(sessionId);
      if (data) {
        const u = data.usage;
        console.log(chalk.gray(`\n  Session: ${sessionId}`));
        console.log(chalk.gray(`  Title:   ${data.session.title ?? '(untitled)'}`));
        console.log(chalk.gray(`  Status:  ${data.session.status}`));
        console.log(chalk.gray(`  Messages: ${data.messages.length}`));
        if (u.messageCount > 0) {
          console.log(
            chalk.gray(
              `  Tokens:  ${u.totalInputTokens} in · ${u.totalOutputTokens} out · ${u.totalReasoningTokens} reasoning`,
            ),
          );
          console.log(chalk.gray(`  Cached:  ${u.totalCachedTokens}`));
          console.log(chalk.gray(`  Time:    ${(u.totalDurationMs / 1000).toFixed(1)}s total`));
        }
      }
      console.log('');
      continue;
    }

    await streamChat(sessionId, trimmed);
  }

  rl.close();
  console.log(chalk.gray(`\n  Session saved: ${sessionId.slice(0, 8)}...`));
  console.log(chalk.gray('  Bye! 🌱\n'));
  return 0;
}
