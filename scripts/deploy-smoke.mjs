#!/usr/bin/env node
/**
 * Stateless deploy smoke test: runs the image the way a container platform does.
 *
 *   node scripts/deploy-smoke.mjs [--image <ref>] [--build] [--keep]
 *
 * Postgres + SeaweedFS (S3 with signature checks) run as throwaway containers on a private network. The app
 * container gets only platform-style env (PORT, DATABASE_URL, two keys,
 * MIGRATE_ON_START, BOOTSTRAP_ADMIN_EMAIL, PUBLIC_BASE_URL, STORAGE_S3_*): no
 * volume, no exec, no LLM. The test claims the instance through the logged
 * activation link, signs in, uploads an image, then replaces the container with
 * a fresh one and reads the image back, which proves no state lived on its disk.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const IMAGE = option('--image', 'greenhouse:deploy-smoke');
const RUN = randomBytes(3).toString('hex');
const NET = `gh-smoke-${RUN}`;
const PG = `gh-smoke-pg-${RUN}`;
const S3 = `gh-smoke-s3-${RUN}`;
const APP = `gh-smoke-app-${RUN}`;
const HOST_PORT = Number(option('--port', '18765'));
const BASE = `http://127.0.0.1:${HOST_PORT}`;
const ADMIN_EMAIL = 'owner@example.com';
const ADMIN_PASSWORD = `smoke-${randomBytes(8).toString('hex')}`;
const BUCKET = 'greenhouse';
const S3_USER = 'smokeadmin';
const S3_IMAGE = option('--s3-image', 'chrislusf/seaweedfs:latest');
const S3_SECRET = randomBytes(12).toString('hex');
const PG_PASSWORD = randomBytes(12).toString('hex');

function docker(...argv) {
  return execFileSync('docker', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function step(message) {
  console.log(`\n▶ ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label} not ready after ${timeoutMs / 1000}s${last ? ` (${last})` : ''}`);
}

function appEnv() {
  return {
    PORT: '8080',
    DATABASE_URL: `postgresql://greenhouse:${PG_PASSWORD}@${PG}:5432/greenhouse`,
    TOKEN_SIGNING_KEY: randomBytes(32).toString('hex'),
    PROVIDER_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    MIGRATE_ON_START: '1',
    BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    PUBLIC_BASE_URL: BASE,
    STORAGE_S3_ENDPOINT: `http://${S3}:8333`,
    STORAGE_S3_BUCKET: BUCKET,
    STORAGE_S3_ACCESS_KEY_ID: S3_USER,
    STORAGE_S3_SECRET_ACCESS_KEY: S3_SECRET,
    // A platform has no proxy; Docker Desktop / OrbStack inject the host's, unreachable in here.
    HTTPS_PROXY: '',
    https_proxy: '',
    HTTP_PROXY: '',
    http_proxy: '',
  };
}

// Keys are generated once per run: the second container must share them.
const ENV = appEnv();

function startApp() {
  const envArgs = Object.entries(ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  docker('run', '-d', '--name', APP, '--network', NET, '-p', `127.0.0.1:${HOST_PORT}:8080`, ...envArgs, IMAGE);
}

function appLogs() {
  const r = spawnSync('docker', ['logs', APP], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

async function waitHealthy() {
  await waitFor(
    'app /health',
    async () => {
      const state = docker('inspect', '-f', '{{.State.Running}}', APP);
      if (state !== 'true') fail(`app container exited:\n${appLogs().slice(-4000)}`);
      return (await fetch(`${BASE}/health`)).ok;
    },
    240_000,
  );
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// Smallest valid PNG (1×1, transparent).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Runs one `weed shell` command in the S3 container; returns its output, or '' on failure. */
function s3Shell(command) {
  const r = spawnSync('docker', ['exec', '-i', S3, 'weed', 'shell'], { input: `${command}\n`, encoding: 'utf8' });
  return r.status === 0 ? `${r.stdout}${r.stderr}` : '';
}

/** Object keys in the bucket, from the filer's directory tree. */
function bucketListing() {
  return s3Shell(`fs.tree /buckets/${BUCKET}`);
}

function cleanup() {
  for (const name of [APP, S3, PG]) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', NET], { stdio: 'ignore' });
}

async function main() {
  if (flag('--build')) {
    step(`build ${IMAGE}`);
    execFileSync('docker', ['build', '-t', IMAGE, '.'], { stdio: 'inherit' });
  }

  step('start Postgres and SeaweedFS');
  docker('network', 'create', NET);
  docker(
    'run',
    '-d',
    '--name',
    PG,
    '--network',
    NET,
    '-e',
    'POSTGRES_USER=greenhouse',
    '-e',
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e',
    'POSTGRES_DB=greenhouse',
    'postgres:16-alpine',
  );
  // Credentials configured, so the server verifies every SigV4 signature (anonymous access is refused).
  const s3Dir = mkdtempSync(join(tmpdir(), 'gh-smoke-s3-'));
  writeFileSync(
    join(s3Dir, 's3.json'),
    JSON.stringify({
      identities: [
        {
          name: 'admin',
          credentials: [{ accessKey: S3_USER, secretKey: S3_SECRET }],
          actions: ['Admin', 'Read', 'Write', 'List'],
        },
      ],
    }),
  );
  docker(
    'run',
    '-d',
    '--name',
    S3,
    '--network',
    NET,
    '-v',
    `${s3Dir}:/etc/smoke:ro`,
    S3_IMAGE,
    'server',
    '-dir=/data',
    '-s3',
    '-s3.config=/etc/smoke/s3.json',
  );
  await waitFor(
    'Postgres',
    () => spawnSync('docker', ['exec', PG, 'pg_isready', '-U', 'greenhouse']).status === 0,
    60_000,
  );
  await waitFor(
    'S3 bucket',
    () => s3Shell(`s3.bucket.create -name ${BUCKET}`) && s3Shell('s3.bucket.list').includes(BUCKET),
    120_000,
  );

  step('first boot: empty database, no volume, platform env only');
  startApp();
  await waitHealthy();

  step('claim the instance through the logged activation link');
  let token = '';
  await waitFor(
    'activation link in the log',
    () => {
      const match = appLogs().match(/\/activate#token=([A-Za-z0-9_.~%-]+)/);
      token = match ? decodeURIComponent(match[1]) : '';
      return Boolean(token);
    },
    30_000,
  );
  const setup = await api('/api/bootstrap');
  if (setup.body?.setup_pending !== true)
    fail(`expected setup_pending=true before claiming, got ${JSON.stringify(setup.body)}`);
  const completed = await api('/api/auth/password-link/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: ADMIN_PASSWORD }),
  });
  if (completed.status !== 200 || !completed.body?.accessToken)
    fail(`activation failed: ${completed.status} ${JSON.stringify(completed.body)}`);
  const claimed = await api('/api/bootstrap');
  if (claimed.body?.setup_pending !== false) fail('setup_pending stayed true after claiming');

  step('sign in and upload an image');
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (login.status !== 200 || !login.body?.accessToken)
    fail(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'pixel.png');
  const uploaded = await api('/api/upload', {
    method: 'POST',
    headers: { authorization: `Bearer ${login.body.accessToken}` },
    body: form,
  });
  if (uploaded.status !== 200 || !uploaded.body?.id)
    fail(`upload failed: ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
  const objects = bucketListing();
  if (!objects.includes(uploaded.body.id)) fail(`upload is not in the bucket:\n${objects}`);

  step('replace the container with a fresh one (same database, same bucket)');
  docker('rm', '-f', APP);
  startApp();
  await waitHealthy();
  if (/\/activate#token=/.test(appLogs())) fail('second boot issued another activation link');
  const relogin = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (relogin.status !== 200) fail(`login after replacement failed: ${relogin.status}`);
  const res = await fetch(`${BASE}/api/upload/${uploaded.body.id}`, {
    headers: { authorization: `Bearer ${relogin.body.accessToken}` },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200 || !bytes.equals(PNG))
    fail(`image not readable after replacement: HTTP ${res.status}, ${bytes.length} bytes`);

  console.log('\n✓ deploy smoke passed: migrate on start, first admin from the log, S3 storage, stateless container');
}

main()
  .catch((err) => {
    console.error(`\n✗ deploy smoke failed: ${err instanceof Error ? err.message : String(err)}`);
    if (spawnSync('docker', ['inspect', APP], { stdio: 'ignore' }).status === 0) {
      console.error(`\n--- app log (tail) ---\n${appLogs().slice(-6000)}`);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    if (flag('--keep')) console.log(`kept containers (network ${NET})`);
    else cleanup();
  });
