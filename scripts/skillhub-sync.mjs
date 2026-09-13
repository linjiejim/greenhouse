#!/usr/bin/env node
// skillhub → Skill Center 幂等同步。
//
// 真源是仓库 skillhub/ 目录：每包 SKILL.md frontmatter 的 version + CHANGELOG.md
// 最新条目是版本事实。脚本对比中心的 content_hash（与服务端 bundle.ts 同一
// canonical 算法）：内容没变跳过；变了且 version 已 bump 就发布；变了没 bump 报错。
//
// 通道：POST $GREENHOUSE_MCP_URL 的 JSON-RPC tools/call（服务端无状态，无需
// initialize）。鉴权走 OAuth client_credentials：启动时用机器客户端凭证在
// /oauth/token 换一个 1 小时 access token，owner 即客户端绑定的内部用户。
//
// 用法：
//   GREENHOUSE_CLIENT_ID=lpoa_client_xxx GREENHOUSE_CLIENT_SECRET=lpoa_cs_xxx \
//     node scripts/skillhub-sync.mjs
//   node scripts/skillhub-sync.mjs --dry-run [--only my-skill]

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://greenhouse.example.com/api/mcp';
const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'svg',
  'html',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'json',
  'yml',
  'yaml',
  'xml',
  'csv',
]);

// ── 纯函数（tests/skillhub 里有单测）────────────────────────

export function parseFrontmatter(skillMd) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(name|description|version):\s*(.+)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// SKILL.md 的一级标题作为目录里的 display_name
export function deriveDisplayName(skillMd) {
  const body = skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading ? heading[1].trim() : undefined;
}

// CHANGELOG.md 里 `## <version>` 小节的正文，作为发布 changelog
export function extractChangelog(changelogMd, version) {
  const lines = changelogMd.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}(\\s|$)`).test(l.trim()));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l.trim()));
  const body = rest
    .slice(0, end < 0 ? rest.length : end)
    .join('\n')
    .trim();
  return body || undefined;
}

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`非法版本号: ${a} / ${b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// 与服务端 validateBundleFiles 相同的 canonical 形态：按 path 排序，utf8 省略 encoding
export function canonicalFiles(files) {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) =>
      f.encoding === 'base64'
        ? { path: f.path, content: f.content, encoding: 'base64' }
        : { path: f.path, content: f.content },
    );
}

// 与服务端 bundleContentHash 相同的完整性哈希
export function contentHash(files) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalFiles(files)))
    .digest('hex');
}

// 发布决策：{action: 'create' | 'update' | 'skip' | 'error', reason}
export function decideAction(local, remote) {
  if (!parseSemver(local.version)) return { action: 'error', reason: `frontmatter version 非法: ${local.version}` };
  if (!remote) {
    return local.changelog
      ? { action: 'create' }
      : { action: 'error', reason: `CHANGELOG.md 缺少 ${local.version} 条目` };
  }
  if (remote.latestHash === local.hash) return { action: 'skip', reason: '内容未变' };
  const cmp = compareSemver(local.version, remote.latestVersion);
  if (cmp <= 0) {
    return {
      action: 'error',
      reason: `内容已变但版本未递增（本地 ${local.version} ≤ 中心 ${remote.latestVersion}），先 bump version 并补 CHANGELOG`,
    };
  }
  if (!local.changelog) return { action: 'error', reason: `CHANGELOG.md 缺少 ${local.version} 条目` };
  return { action: 'update' };
}

// ── 目录扫描 ──────────────────────────────────────────

export function collectSkillDirs(root) {
  const found = [];
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name);
      if (!statSync(dir).isDirectory()) continue;
      try {
        statSync(join(dir, 'SKILL.md'));
        found.push({ group, name, dir });
      } catch {
        // 没有 SKILL.md 的目录不是技能包
      }
    }
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function readBundleFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const path = relative(dir, full).split('\\').join('/');
      const ext = entry.includes('.') ? entry.split('.').pop().toLowerCase() : '';
      if (TEXT_EXTENSIONS.has(ext)) files.push({ path, content: readFileSync(full, 'utf8') });
      else files.push({ path, content: readFileSync(full).toString('base64'), encoding: 'base64' });
    }
  };
  walk(dir);
  return canonicalFiles(files);
}

export function loadLocalSkill({ group, name, dir }) {
  const files = readBundleFiles(dir);
  const skillMd = files.find((f) => f.path === 'SKILL.md')?.content ?? '';
  const frontmatter = parseFrontmatter(skillMd);
  const changelogMd = files.find((f) => f.path === 'CHANGELOG.md')?.content ?? '';
  const version = frontmatter.version ?? '';
  return {
    group,
    name,
    dir,
    files,
    frontmatterName: frontmatter.name,
    description: frontmatter.description,
    displayName: deriveDisplayName(skillMd),
    version,
    changelog: version ? extractChangelog(changelogMd, version) : undefined,
    hash: contentHash(files),
  };
}

// ── MCP 通道 ─────────────────────────────────────────

// client_credentials 换 access token；token 端点挂在 MCP URL 同 origin 的根路径
async function exchangeAccessToken(mcpUrl, clientId, clientSecret) {
  const tokenUrl = new URL('/oauth/token', mcpUrl).href;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `OAuth token 交换失败 (HTTP ${response.status}): ${payload.error_description ?? payload.error ?? 'unknown'}`,
    );
  }
  return payload.access_token;
}

async function mcpCall(url, key, tool, args, id) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  const payload = text.trimStart().startsWith('{')
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('') || '{}',
      );
  if (payload.error) throw new Error(`MCP error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
  const content = payload.result?.structuredContent ?? payload.result?.content?.find((c) => c.type === 'text')?.text;
  if (content === undefined) return payload.result ?? {};
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return { raw: content };
    }
  }
  return content;
}

async function fetchRemote(url, key, name, id) {
  const detail = await mcpCall(url, key, 'skill_query', { action: 'skills.get', name }, id);
  if (detail?.error) return null; // not found 也走 error 字段
  const latestVersion = detail?.skill?.latest_version;
  const latestHash = detail?.versions?.find((v) => v.version === latestVersion)?.content_hash;
  if (!latestVersion) return null;
  return { latestVersion, latestHash };
}

// ── 主流程 ───────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;

  const url = process.env.GREENHOUSE_MCP_URL || DEFAULT_URL;
  const clientId = process.env.GREENHOUSE_CLIENT_ID;
  const clientSecret = process.env.GREENHOUSE_CLIENT_SECRET;
  if ((!clientId || !clientSecret) && !dryRun) {
    console.error(
      '缺少 GREENHOUSE_CLIENT_ID / GREENHOUSE_CLIENT_SECRET（管理员在 MCP Access 面板创建机器客户端获取）。只看计划可加 --dry-run。',
    );
    process.exit(1);
  }
  const key = clientId && clientSecret ? await exchangeAccessToken(url, clientId, clientSecret) : undefined;

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../skillhub');
  let skills = collectSkillDirs(root).map(loadLocalSkill);
  if (only) skills = skills.filter((s) => s.name === only);
  if (skills.length === 0) {
    console.error(only ? `找不到技能: ${only}` : 'skillhub 目录为空');
    process.exit(1);
  }

  let failed = false;
  let id = 0;
  for (const skill of skills) {
    if (skill.frontmatterName !== skill.name) {
      console.error(`✗ ${skill.name}: frontmatter name (${skill.frontmatterName}) 与目录名不一致`);
      failed = true;
      continue;
    }
    const remote = dryRun && !key ? null : await fetchRemote(url, key, skill.name, ++id);
    const decision = decideAction(skill, remote);

    if (decision.action === 'error') {
      console.error(`✗ ${skill.name}: ${decision.reason}`);
      failed = true;
      continue;
    }
    if (decision.action === 'skip') {
      console.log(`= ${skill.name}@${skill.version} 未变，跳过`);
      continue;
    }
    const verb = decision.action === 'create' ? '首发' : '更新';
    if (dryRun) {
      console.log(`→ ${skill.name}@${skill.version} 将${verb}（${skill.files.length} 个文件)`);
      continue;
    }
    const result = await mcpCall(
      url,
      key,
      'skill_mutation',
      {
        action: 'skills.publish',
        name: skill.name,
        version: skill.version,
        changelog: skill.changelog,
        description: skill.description,
        display_name: skill.displayName,
        tags: ['official', skill.group],
        files: skill.files,
        confirm: true,
      },
      ++id,
    );
    if (result?.error) {
      console.error(`✗ ${skill.name}: ${result.error}`);
      failed = true;
    } else {
      console.log(`✓ ${skill.name}@${skill.version} ${verb}完成`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
