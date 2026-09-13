/**
 * `cli knowledge` — knowledge-base maintenance.
 *
 *   pnpm cli knowledge reindex          Recompute segmented FTS tokens.
 *   pnpm cli knowledge migrate-spaces   Convert meta.space groups → kb folders.
 *   pnpm cli knowledge import <dir>     Seed a folder of Markdown files into the team KB.
 *
 * All are idempotent. Run `reindex` after a segmentation change to backfill
 * token columns; run `migrate-spaces` once to fold the legacy one-level `space`
 * grouping into the drive_folders directory tree.
 *
 * `import` treats the directory as the seed of a KB column: the directory name
 * (or `--folder`) becomes a top-level team folder, each first-level
 * subdirectory becomes a subfolder, every `*.md` becomes a document whose
 * `doc_id` is derived from its path, and `assets/*` images are uploaded under
 * deterministic ids so a re-run maps to the same URLs. The KB owns the docs
 * after seeding — re-running skips existing docs unless `--force`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import chalk from 'chalk';
import { safeJsonParse } from '@greenhouse/utils/json';
import { markdownToTiptapJson } from '@greenhouse/knowledge-editor/markdown';
import { putUpload } from '../../storage/uploads.js';
import { openDb, parseFlags, flagNum, flagBool, flagStr } from './shared.js';

const USAGE = `${chalk.bold('cli knowledge')} — knowledge-base maintenance

${chalk.bold('Usage:')} pnpm cli knowledge <reindex|migrate-spaces|import> [--flags]

${chalk.bold('Subcommands')}
  reindex          Recompute segmented FTS tokens for all knowledge_base rows.
                   Idempotent. --batch <n>   rows per keyset page (default 200)
  migrate-spaces   Fold distinct meta.space (≠ 'general') into kb team folders
                   and set knowledge_base.folder_id; clears the migrated space.
                   Idempotent. --dry-run to preview.
  import <dir>     Seed a directory of Markdown files into the team KB as one
                   top-level folder (default: the directory name; --folder <name>
                   to override). First-level subdirectories become subfolders,
                   titles come from each file's first heading, and assets/*.png|jpg
                   are uploaded under deterministic ids. ${chalk.bold('Skips docs that already exist')}
                   — the KB owns them after seeding. --dry-run to preview,
                   --force to overwrite existing docs, --tag <tag> (default: the
                   folder name).`;

async function reindex(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const batch = flagNum(flags, 'batch', 200);
  const db = await openDb();

  console.log(chalk.bold('Reindexing segmented FTS tokens…'));

  const kb = await db.knowledgeBase.reindexTokens(batch, (done) => {
    process.stdout.write(`\r  knowledge_base: ${done} rows`);
  });
  process.stdout.write(`\r  knowledge_base: ${chalk.green(`${kb} rows`)}          \n`);

  console.log(chalk.green(`\n✓ Reindexed ${kb} rows.`));
  return 0;
}

/**
 * Fold the legacy one-level `meta.space` grouping into the drive_folders tree:
 * each distinct team-doc space (≠ 'general') becomes a top-level kb team folder;
 * the doc's folder_id is set and its meta.space cleared. Idempotent — a folder
 * of the same name is reused, and already-migrated docs (space already cleared)
 * are skipped.
 */
async function migrateSpaces(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  const dryRun = flagBool(flags, 'dry-run');
  const db = await openDb();

  // Team docs carrying a non-general space.
  const docs = (await db.knowledgeBase.listAll('shared')).filter((d) => {
    if (d.visibility !== 'team') return false;
    const space = (safeJsonParse(d.meta || '{}', {}) as Record<string, unknown>).space;
    return typeof space === 'string' && space && space !== 'general';
  });

  if (docs.length === 0) {
    console.log(chalk.green('✓ No non-general team spaces to migrate.'));
    return 0;
  }

  // Group by space name.
  const bySpace = new Map<string, typeof docs>();
  for (const d of docs) {
    const space = String((safeJsonParse(d.meta || '{}', {}) as Record<string, unknown>).space);
    (bySpace.get(space) ?? bySpace.set(space, []).get(space)!).push(d);
  }

  console.log(chalk.bold(`${dryRun ? '[dry-run] ' : ''}Migrating ${bySpace.size} space(s), ${docs.length} doc(s):`));

  // Reuse an existing top-level kb team folder of the same name if present.
  const existingRoots = await db.drive.listFolders({ scope: 'kb', parent_id: null, visibility: 'team' });
  const rootByName = new Map(existingRoots.map((f) => [f.name, f]));

  for (const [space, spaceDocs] of bySpace) {
    let folder = rootByName.get(space);
    console.log(`  • ${space}  (${spaceDocs.length} doc)  → folder ${folder ? `#${folder.id} (reuse)` : '(new)'}`);
    if (dryRun) continue;
    if (!folder) {
      folder = await db.drive.createFolder({ scope: 'kb', name: space, visibility: 'team', created_by: 'migration' });
      rootByName.set(space, folder);
    }
    for (const d of spaceDocs) {
      const meta = safeJsonParse(d.meta || '{}', {}) as Record<string, unknown>;
      delete meta.space;
      await db.knowledgeBase.update(
        d.id,
        { folder_id: folder.id, meta },
        'migration',
        `Migrated space "${space}" to folder`,
      );
    }
  }

  console.log(
    chalk.green(
      `\n✓ ${dryRun ? '(dry-run) would migrate' : 'Migrated'} ${docs.length} doc(s) into ${bySpace.size} folder(s).`,
    ),
  );
  return 0;
}

// ─── import <dir> ────────────────────────────────────────

interface SeedDocSpec {
  docId: string;
  title: string;
  /** Subfolder under the root folder; '' = root. */
  folder: string;
  path: string;
}

interface SeedTreeConfig {
  /** Root team folder name. */
  rootFolder: string;
  tag: string;
  createdBy: string;
  /** Deterministic upload id for an asset file name (same id every run). */
  uploadId: (assetName: string) => string;
}

function markdownTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1]!.trim() : fallback;
}

function slugOf(file: string): string {
  return file.replace(/\.md$/i, '');
}

/**
 * Collect the doc set from the directory layout so adding an article is adding
 * a file — no parallel manifest to keep in sync.
 *
 *   <dir>/<file>.md              → doc_id <prefix>/<slug>             (root folder)
 *   <dir>/<section>/<file>.md    → doc_id <prefix>/<section>/<slug>   (subfolder <section>)
 *
 * `assets/` is reserved for images and never becomes a folder.
 */
function collectDocs(dir: string, prefix: string): SeedDocSpec[] {
  const docs: SeedDocSpec[] = [];
  const rootFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();
  for (const file of rootFiles) {
    const path = join(dir, file);
    const slug = slugOf(file);
    docs.push({ docId: `${prefix}/${slug}`, title: markdownTitle(readFileSync(path, 'utf8'), slug), folder: '', path });
  }
  const sections = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'assets' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const section of sections) {
    const sectionPath = join(dir, section);
    const files = readdirSync(sectionPath)
      .filter((f) => f.endsWith('.md'))
      .sort();
    for (const file of files) {
      const path = join(sectionPath, file);
      const slug = slugOf(file);
      docs.push({
        docId: `${prefix}/${section}/${slug}`,
        title: markdownTitle(readFileSync(path, 'utf8'), slug),
        folder: section,
        path,
      });
    }
  }
  return docs;
}

/**
 * Seed a KB column from collected specs: upload embedded assets under
 * deterministic ids, ensure the two-level folder tree, upsert docs.
 *
 * SEED SEMANTICS: the KB is the source of truth once seeded, so an existing doc
 * is left alone unless `force`. A re-run therefore backfills what is missing
 * without eating anyone's edits.
 */
async function importSeedTree(
  dir: string,
  specs: SeedDocSpec[],
  cfg: SeedTreeConfig,
  opts: { dryRun: boolean; force: boolean },
): Promise<number> {
  const { dryRun, force } = opts;
  const db = await openDb();
  console.log(chalk.bold(`${dryRun ? '[dry-run] ' : ''}Importing ${cfg.rootFolder} KB from ${dir}`));
  console.log(force ? chalk.yellow('  --force: existing docs will be OVERWRITTEN') : '  mode: seed (skip existing)');

  // 1. Upload image assets under deterministic ids.
  const assetsDir = join(dir, 'assets');
  const urlByAsset = new Map<string, string>();
  const assetFiles = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    : [];
  for (const name of assetFiles) {
    const id = cfg.uploadId(name);
    urlByAsset.set(name, `/api/upload/${id}`);
    if (dryRun) continue;
    const buffer = readFileSync(join(assetsDir, name));
    const contentType = /\.png$/i.test(name)
      ? 'image/png'
      : /\.jpe?g$/i.test(name)
        ? 'image/jpeg'
        : /\.webp$/i.test(name)
          ? 'image/webp'
          : 'image/gif';
    await putUpload(id, buffer, contentType);
  }
  console.log(`  assets: ${chalk.green(`${assetFiles.length}${dryRun ? ' (not uploaded in dry-run)' : ' uploaded'}`)}`);

  // 2. Ensure the folder tree <root>/{...section folders}.
  async function ensureFolder(name: string, parentId: number | null): Promise<number> {
    const siblings = await db.drive.listFolders({ scope: 'kb', parent_id: parentId, visibility: 'team' });
    const existing = siblings.find((f) => f.name === name);
    if (existing) return existing.id;
    if (dryRun) return -1;
    const created = await db.drive.createFolder({
      scope: 'kb',
      parent_id: parentId,
      name,
      visibility: 'team',
      created_by: cfg.createdBy,
    });
    return created.id;
  }

  const rootId = await ensureFolder(cfg.rootFolder, null);
  const folderIdByName = new Map<string, number>([['', rootId]]);
  // Specs arrive in tree order, so first-seen order IS the intended folder order.
  const usedFolders = [...new Set(specs.map((s) => s.folder).filter(Boolean))];
  for (const folder of usedFolders) folderIdByName.set(folder, await ensureFolder(folder, rootId));
  console.log(
    `  folders: ${chalk.green(`${cfg.rootFolder} (#${rootId})${usedFolders.length ? ' + ' + usedFolders.join(' / ') : ''}`)}`,
  );

  // 3. Upsert docs with image URLs rewritten to /api/upload/<id>. An
  // unresolvable `assets/<name>` reference stops the import and names the
  // missing files rather than surviving into the doc as a dead relative path.
  const unresolved = new Set<string>();
  const rendered = specs.map((spec) => {
    let content = readFileSync(spec.path, 'utf8');
    for (const [name, url] of urlByAsset) content = content.replaceAll(`assets/${name}`, url);
    for (const [, ref] of content.matchAll(/\]\((assets\/[^)]+)\)/g)) unresolved.add(ref);
    return { spec, content };
  });
  if (unresolved.size > 0) {
    console.error(chalk.red(`\n✗ ${unresolved.size} image reference(s) have no file under ${assetsDir}:`));
    for (const ref of unresolved) console.error(chalk.red(`    ${ref}`));
    return 1;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const { spec, content } of rendered) {
    const folderId = folderIdByName.get(spec.folder)!;
    const existing = await db.knowledgeBase.get(spec.docId);
    const action = existing ? (force ? 'update' : 'skip') : 'create';

    if (dryRun) {
      console.log(`  • ${spec.docId} → ${cfg.rootFolder}${spec.folder ? `/${spec.folder}` : ''} (${action})`);
      if (action === 'create') created += 1;
      else if (action === 'update') updated += 1;
      else skipped += 1;
      continue;
    }

    if (action === 'skip') {
      skipped += 1;
      continue;
    }

    await db.knowledgeBase.upsert({
      doc_id: spec.docId,
      scope: 'shared',
      title: spec.title,
      content,
      content_json: markdownToTiptapJson(content),
      visibility: 'team',
      status: 'published',
      tags: [cfg.tag],
      folder_id: folderId,
      created_by: cfg.createdBy,
    });
    // upsert leaves folder_id untouched on conflict — enforce placement.
    const row = await db.knowledgeBase.get(spec.docId);
    if (row && row.folder_id !== folderId) {
      await db.knowledgeBase.update(
        row.id,
        { folder_id: folderId },
        cfg.createdBy,
        `Moved into ${cfg.rootFolder} folder tree`,
      );
    }
    if (existing) updated += 1;
    else created += 1;
  }

  console.log(
    chalk.green(
      `\n✓ ${dryRun ? '(dry-run) previewed' : 'Imported'} ${specs.length} docs (${created} created, ${updated} updated, ${skipped} skipped), ${assetFiles.length} assets.`,
    ),
  );
  if (skipped > 0 && !force) {
    console.log(chalk.dim(`  ${skipped} doc(s) already exist and were left untouched. Use --force to overwrite.`));
  }
  return 0;
}

/** `pnpm cli knowledge import <dir> [--folder <name>] [--tag <tag>] [--dry-run] [--force]` */
async function importDir(args: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(args);
  const dirArg = positionals[0] ?? flagStr(flags, 'dir');
  if (!dirArg) {
    console.error(
      chalk.red('Usage: pnpm cli knowledge import <dir> [--folder <name>] [--tag <tag>] [--dry-run] [--force]'),
    );
    return 1;
  }
  const dir = resolve(dirArg);
  if (!existsSync(dir)) {
    console.error(chalk.red(`Content dir not found: ${dir}`));
    return 1;
  }
  const rootFolder = flagStr(flags, 'folder') ?? basename(dir);
  const tag = flagStr(flags, 'tag') ?? rootFolder;
  const prefix = rootFolder
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const dryRun = flagBool(flags, 'dry-run');
  const force = flagBool(flags, 'force');

  let specs: SeedDocSpec[];
  try {
    specs = collectDocs(dir, prefix || 'kb');
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    return 1;
  }
  if (specs.length === 0) {
    console.error(chalk.red(`No Markdown files found under ${dir}`));
    return 1;
  }

  const uploadId = (assetName: string): string => {
    const ext = assetName.slice(assetName.lastIndexOf('.'));
    const hash = createHash('sha1').update(`${prefix}/${assetName}`).digest('hex').slice(0, 8);
    return `1753300000000-${hash}${ext}`;
  };

  return importSeedTree(dir, specs, { rootFolder, tag, createdBy: 'knowledge-import', uploadId }, { dryRun, force });
}

export async function run(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(USAGE);
    return sub ? 0 : 1;
  }
  switch (sub) {
    case 'reindex':
      return reindex(args.slice(1));
    case 'migrate-spaces':
      return migrateSpaces(args.slice(1));
    case 'import':
      return importDir(args.slice(1));
    default:
      console.error(chalk.red(`Unknown knowledge subcommand: ${sub} — use: reindex | migrate-spaces | import`));
      return 1;
  }
}
