/**
 * Data catalog (数据目录) — what data the team has, as one member may see it,
 * and how that member's agent reaches each source.
 *
 * Active plugins contribute authorized collections through catalogSources and
 * describe reachable data tools, search lanes and export sources. Every loader
 * receives the caller's platform actor and reachable tool set.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { ActorContext } from '@greenhouse/platform-kernel';
import type { DataCatalog, DataCatalogExtensionSource, DataCatalogReach } from '@greenhouse/types/hub-context';
import { getToolMeta } from '../tools/registry.js';
import { fromExtensions, EXTENSIONS } from '../plugin-host/index.js';

export interface CatalogInput {
  db: DatabaseProvider;
  /** Who is asking — a human for the web page, the delegated agent on MCP. */
  actor: ActorContext;
  /** The MCP tools the caller reaches (see module doc). */
  reachable: ReadonlySet<string>;
  /** False skips the per-table row counts (a summary only needs the list). */
  counts?: boolean;
}

/** The first sentence of a tool description: enough to say what it is for. */
function firstSentence(text: string): string {
  const match = /^(.{20,200}?[.。])(\s|$)/s.exec(text.trim());
  const sentence = (match ? match[1]! : text.trim()).replace(/\s+/g, ' ');
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

function toolReach(toolId: string, how: string): DataCatalogReach | null {
  const meta = getToolMeta(toolId);
  if (!meta?.surface?.proxy) return null;
  return {
    tool: toolId,
    access: meta.surface.proxy === 'write' ? 'write' : 'read',
    group: typeof meta.surface.mcp === 'string' ? meta.surface.mcp : null,
    how,
  };
}

function extensionSources(reachable: ReadonlySet<string>): DataCatalogExtensionSource[] {
  const out: DataCatalogExtensionSource[] = [];
  for (const ext of EXTENSIONS) {
    if (ext.catalogSources?.some((source) => source.replaceDefaultSource)) continue;
    const tools = (ext.tools ?? []).map((mod) => mod.meta).filter((meta) => meta.surface?.mcp && meta.surface.proxy);
    const searchKinds = (ext.searchSources ?? []).map((source) => source.kind);
    const exports = (ext.exportSources ?? []).map((source) => ({ type: source.type, describe: source.describe }));
    // Not a data source: an extension with no data tools, search lanes or exports.
    if (tools.length === 0 && searchKinds.length === 0 && exports.length === 0) continue;
    const reach = tools
      .filter((meta) => reachable.has(meta.id))
      .map((meta) => toolReach(meta.id, firstSentence(meta.description)))
      .filter((entry): entry is DataCatalogReach => entry !== null);
    // The member (or this grant) reaches none of its tools: not theirs to see.
    if (reach.length === 0) continue;
    if (exports.length > 0) {
      reach.push({
        tool: 'export_data',
        access: 'read',
        group: null,
        how: `In Greenhouse chat only: export_data with source type ${exports.map((entry) => entry.type).join(' / ')}`,
      });
    }
    out.push({
      kind: 'extension',
      id: ext.id,
      name: ext.name,
      description: ext.description ?? null,
      record_kinds: searchKinds,
      exports,
      reach,
    });
  }
  return out;
}

export async function buildDataCatalog(input: CatalogInput): Promise<DataCatalog> {
  const contributions = await Promise.all(fromExtensions('catalogSources').map((source) => source.load(input)));
  const bases = contributions.flatMap((entry) => entry.bases ?? []);
  const truncated = contributions.some((entry) => entry.truncated);
  return {
    generated_at: new Date().toISOString(),
    bases,
    extensions: [...extensionSources(input.reachable), ...contributions.flatMap((entry) => entry.extensions ?? [])],
    truncated,
  };
}
