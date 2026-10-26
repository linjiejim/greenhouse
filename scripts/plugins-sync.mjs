#!/usr/bin/env node
/** Assemble configured packages using static imports; never load either code half here. */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePluginsEnv } from '../packages/types/src/config.ts';
import { parseGreenhouseConfig } from '../packages/types/src/config-schema.ts';
import { EXTENSION_SDK } from '../packages/utils/src/extension-compat.ts';
import { isValidSemver, releaseTriple } from '../packages/utils/src/semver.ts';
import { format } from 'prettier';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inside = (root, path) => path === root || path.startsWith(root + sep);

function jsonData(value, at = 'manifest', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (
    typeof value !== 'object' ||
    seen.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  ) {
    throw new Error(`${at} must contain only JSON-serialisable data`);
  }
  seen.add(value);
  for (const [key, item] of Object.entries(value)) jsonData(item, `${at}.${key}`, seen);
  seen.delete(value);
}

/** Resolve workspace names first (pnpm need not link an unreferenced package at the root). */
function packageDir(root, entry) {
  if (entry.startsWith('./')) {
    const dir = resolve(root, entry);
    if (!inside(root, dir)) throw new Error(`Plugin path escapes repository: ${entry}`);
    return dir;
  }
  if (isAbsolute(entry) || entry.startsWith('.')) throw new Error(`Use a package name or ./relative/path: ${entry}`);
  const workspace = join(root, 'plugins');
  if (existsSync(workspace)) {
    for (const folder of readdirSync(workspace)) {
      const path = join(workspace, folder, 'package.json');
      if (existsSync(path) && readJson(path).name === entry) return dirname(path);
    }
  }
  const require = createRequire(join(root, 'package.json'));
  // Read metadata independently of exports conditions, including import-only
  // packages that intentionally hide their package.json from consumers.
  for (const directory of require.resolve.paths(entry) ?? []) {
    const path = join(directory, entry, 'package.json');
    if (existsSync(path) && readJson(path).name === entry) return dirname(path);
  }
  // Packages may hide package.json in their exports; resolve a public entry then find the root.
  let resolved;
  for (const candidate of [`${entry}/package.json`, `${entry}/manifest`, `${entry}/api`, `${entry}/web`, entry]) {
    try {
      resolved = require.resolve(candidate);
      break;
    } catch {
      /* try the next public entry */
    }
  }
  if (!resolved) throw new Error(`Cannot resolve plugin package ${entry}; install it first`);
  let dir = dirname(resolved);
  while (dirname(dir) !== dir) {
    const path = join(dir, 'package.json');
    if (existsSync(path) && readJson(path).name === entry) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Cannot find package.json for plugin ${entry}`);
}

function exportedTarget(value) {
  if (typeof value === 'string') return value;
  return value?.import ?? value?.default;
}

export async function resolvePlugins(root = REPO_ROOT, env = process.env) {
  const configFile = resolve(root, env.GREENHOUSE_CONFIG ?? 'greenhouse.config.ts');
  const configModule = existsSync(configFile) ? await import(pathToFileURL(configFile).href) : {};
  const config = parseGreenhouseConfig(configModule.default ?? configModule.config ?? {});
  const entries = parsePluginsEnv(env.GREENHOUSE_PLUGINS) ?? config.plugins;
  const plugins = [];
  const ids = new Set();
  for (const entry of entries) {
    const dir = packageDir(root, entry);
    const pkg = readJson(join(dir, 'package.json'));
    const declaration = pkg.greenhouse;
    if (!declaration || !/^[a-z][a-z0-9-]*$/.test(declaration.id))
      throw new Error(`${entry}: missing or invalid greenhouse.id`);
    const { id, sdk } = declaration;
    if (ids.has(id)) throw new Error(`Plugin id "${id}" is listed twice`);
    if (sdk !== EXTENSION_SDK && !(EXTENSION_SDK === 2 && sdk === 1))
      throw new Error(`${entry}: unsupported sdk ${sdk}; host supports ${EXTENSION_SDK}`);
    if (basename(dir) !== id && basename(dir) !== `plugin-${id}`)
      throw new Error(`${entry}: id "${id}" must match its folder`);
    const manifestPath = ['manifest.ts', 'manifest.js'].map((file) => join(dir, file)).find(existsSync);
    if (!manifestPath) throw new Error(`${entry}: missing manifest.ts (or compiled manifest.js)`);
    const manifestModule = await import(pathToFileURL(manifestPath).href);
    const manifest = manifestModule.default ?? manifestModule.manifest;
    jsonData(manifest);
    if (manifest.id !== id || manifest.sdk !== sdk)
      throw new Error(`${entry}: manifest id/sdk does not match package.json`);
    if (
      !pkg.name ||
      typeof manifest.name !== 'string' ||
      !manifest.name.trim() ||
      // Product/plugin releases may carry rc/build suffixes; skill versions remain strict X.Y.Z.
      typeof manifest.version !== 'string' ||
      !isValidSemver(manifest.version.split(/[-+]/)[0]) ||
      !releaseTriple(manifest.version) ||
      manifest.version !== pkg.version
    ) {
      throw new Error(`${entry}: manifest needs a name and a semver version matching package.json`);
    }
    if (!Array.isArray(manifest.dependsOn) || manifest.dependsOn.some((dep) => typeof dep !== 'string' || dep === id)) {
      throw new Error(`${entry}: manifest.dependsOn must list other plugin ids`);
    }
    const halves = {};
    if (
      manifest.ui !== undefined &&
      (typeof manifest.ui !== 'string' ||
        !manifest.ui.startsWith('./') ||
        !inside(dir, resolve(dir, manifest.ui)) ||
        !existsSync(resolve(dir, manifest.ui)) ||
        !statSync(resolve(dir, manifest.ui)).isDirectory())
    )
      throw new Error(`${entry}: ui must name a directory inside the plugin`);
    for (const half of ['api', 'web']) {
      const target = declaration[half];
      if (target === undefined) continue;
      if (
        typeof target !== 'string' ||
        !target.startsWith('./') ||
        !inside(dir, resolve(dir, target)) ||
        !existsSync(resolve(dir, target))
      ) {
        throw new Error(`${entry}: invalid or missing ${half} entry ${target}`);
      }
      const exported = Object.entries(pkg.exports ?? {}).find(([, value]) => exportedTarget(value) === target);
      if (!exported) throw new Error(`${entry}: ${half} entry must be declared in exports`);
      halves[half] =
        inside(join(root, 'plugins'), dir) || entry.startsWith('./')
          ? resolve(dir, target)
          : `${pkg.name}${exported[0] === '.' ? '' : exported[0].slice(1)}`;
    }
    ids.add(id);
    plugins.push({
      id,
      packageName: pkg.name,
      manifest,
      halves,
      uiDir: manifest.ui ? resolve(dir, manifest.ui) : undefined,
    });
  }
  for (const plugin of plugins) {
    for (const dep of plugin.manifest.dependsOn)
      if (!ids.has(dep)) throw new Error(`Plugin "${plugin.id}" depends on "${dep}", which is not listed in plugins`);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(plugin) {
    if (visiting.has(plugin.id)) throw new Error(`Plugin dependency cycle at "${plugin.id}"`);
    if (visited.has(plugin.id)) return;
    visiting.add(plugin.id);
    for (const id of plugin.manifest.dependsOn) visit(plugins.find((p) => p.id === id));
    visiting.delete(plugin.id);
    visited.add(plugin.id);
  }
  plugins.forEach(visit);
  return plugins;
}

export async function syncPlugins({ root = REPO_ROOT, env = process.env, check = false } = {}) {
  const plugins = await resolvePlugins(root, env);
  const outputs = [];
  for (const half of ['api', 'web']) {
    const file = join(root, `apps/${half}/src/extensions/compiled.generated.ts`);
    const type = half === 'api' ? 'GreenhouseExtension' : 'WebExtension';
    const imports = [];
    const values = [];
    plugins.forEach((plugin, i) => {
      const target = plugin.halves[half];
      if (target) {
        const specifier = isAbsolute(target)
          ? './' +
            relative(dirname(file), target)
              .split(sep)
              .join('/')
              .replace(/\.tsx?$/, '.js')
          : target;
        imports.push(`import plugin${i} from ${JSON.stringify(specifier)};`);
        values.push(
          half === 'api' && plugin.uiDir
            ? `{ ...plugin${i}, publicPaths: { ...plugin${i}.publicPaths, prefixes: [...(plugin${i}.publicPaths?.prefixes ?? []), ${JSON.stringify(`/ext/${plugin.id}/ui/`)}] }, ui: { dir: fileURLToPath(new URL(${JSON.stringify('./' + relative(dirname(file), plugin.uiDir).split(sep).join('/'))}, import.meta.url)) } }`
            : `plugin${i}`,
        );
      } else if (half === 'api') {
        // A web-only plugin still has an identity in the existing /api/extensions response.
        const { id, name, description, version, sdk, core, dependsOn, surfaces, official, client_min } =
          plugin.manifest;
        const identity = JSON.stringify({
          id,
          name,
          description,
          version,
          sdk,
          core,
          dependsOn,
          surfaces,
          official,
          client_min,
        });
        values.push(
          plugin.uiDir
            ? `{ ...${identity}, publicPaths: { prefixes: [${JSON.stringify(`/ext/${plugin.id}/ui/`)}] }, ui: { dir: fileURLToPath(new URL(${JSON.stringify('./' + relative(dirname(file), plugin.uiDir).split(sep).join('/'))}, import.meta.url)) } }`
            : identity,
        );
      }
    });
    let content = `// generated by pnpm plugins:sync — do not edit\nimport type { ${type} } from './define${half === 'api' ? '.js' : ''}';\n${imports.join('\n')}\nexport const COMPILED_PLUGINS: readonly ${type}[] = [${values.join(',')}];\n`;
    if (half === 'api') {
      content += `import { fileURLToPath } from 'node:url';\n`;
      content += `export const COMPILED_PLUGIN_PACKAGES: readonly { id: string; packageName: string; manifest: { version: string; sdk: number; dependsOn: string[] }; api: boolean; web: boolean }[] = ${JSON.stringify(plugins.map((p) => ({ id: p.id, packageName: p.packageName, manifest: { version: p.manifest.version, sdk: p.manifest.sdk, dependsOn: p.manifest.dependsOn }, api: Boolean(p.halves.api), web: Boolean(p.halves.web) })))};\n`;
    }
    content = await format(content, { parser: 'typescript', singleQuote: true, printWidth: 120 });
    outputs.push({ file, content });
  }
  const stale = outputs.filter(({ file, content }) => !existsSync(file) || readFileSync(file, 'utf8') !== content);
  if (check && stale.length)
    throw new Error(
      `Plugin registrations missing or stale: ${stale.map(({ file }) => relative(root, file)).join(', ')}. Run pnpm plugins:sync`,
    );
  if (!check) for (const { file, content } of stale) writeFileSync(file, content);
  return plugins;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await syncPlugins({ check: process.argv.includes('--check') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
