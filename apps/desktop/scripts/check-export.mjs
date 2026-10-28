import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = join(process.argv[2], '_expo/static/js/web');
const sources = readdirSync(directory)
  .filter((name) => name.endsWith('.map'))
  .flatMap((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')).sources);
for (const bridge of [
  'config.desktop.ts',
  'api/persistence.desktop.ts',
  'desktop/client-shell.desktop.tsx',
  'desktop/chrome.desktop.ts',
  'desktop/channel.desktop.ts',
  'desktop/refresh-lock.desktop.ts',
]) {
  if (!sources.some((source) => source.endsWith(`/src/${bridge}`)))
    throw new Error(`Desktop bridge was not selected: ${bridge}`);
}
for (const browser of ['config.web.ts', 'api/persistence.web.ts', 'desktop/client-shell.web.tsx']) {
  if (sources.some((source) => source.endsWith(`/src/${browser}`)))
    throw new Error(`Browser adapter leaked into the desktop export: ${browser}`);
}
console.log('Desktop export verified: native bridges selected, browser station/token adapters absent.');
