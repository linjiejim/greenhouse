/** Test support for skills: storage on disk, ZIPs built in memory, uploads through the file service. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { createTestApp } from '../../../testing.js';

type TestApp = ReturnType<typeof createTestApp>;

export function storageEnv() {
  return { STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-skills-')) };
}

export function skillMd(
  name: string,
  options: { description?: string; version?: string; requirements?: string; body?: string } = {},
) {
  return [
    '---',
    `name: ${name}`,
    `description: ${options.description ?? `What ${name} does.`}`,
    ...(options.version ? [`version: ${options.version}`] : []),
    ...(options.requirements ? [options.requirements] : []),
    '---',
    options.body ?? `# ${name}\n\nDo the thing step by step.`,
    '',
  ].join('\n');
}

export const zipOf = (entries: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value]),
    ),
  );

/** Uploads a ZIP with purpose `skill`; the file id. */
export async function uploadZip(app: TestApp, token: string, bytes: Uint8Array, name = 'skill.zip') {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name, { type: 'application/zip' }));
  form.set('purpose', 'skill');
  const response = await app.app.request('/api/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await response.json()) as { id: string };
  if (response.status !== 201) throw new Error(`upload failed: ${JSON.stringify(body)}`);
  return body.id;
}

/** Uploads the files as a package and creates the skill. */
export async function createPackage(
  app: TestApp,
  token: string,
  entries: Record<string, string | Uint8Array>,
  extra: Record<string, unknown> = {},
) {
  const fileId = await uploadZip(app, token, zipOf(entries));
  return app.call('POST', '/api/skills', { token, body: { kind: 'package', file_id: fileId, ...extra } });
}

export function createTemplate(app: TestApp, token: string, body: Record<string, unknown>) {
  return app.call('POST', '/api/skills', {
    token,
    body: { kind: 'template', description: 'A template.', body: 'Do it.', ...body },
  });
}

/** The bytes behind a signed URL, fetched as the member it was made for. */
export async function fetchUrl(app: TestApp, url: string) {
  const response = await app.app.request(url);
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}
