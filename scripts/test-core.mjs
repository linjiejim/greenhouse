#!/usr/bin/env node
/** Exercise the same host with no packages compiled; restore normal assembly even on failure. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

const env = { ...process.env, GREENHOUSE_PLUGINS: '', GREENHOUSE_EXTENSIONS: '' };
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function run(args, overrides = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, { env: overrides, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pnpm ${args.join(' ')} exited ${code}`))));
  });
}
async function smoke() {
  if (!env.TEST_DATABASE_URL) throw new Error('test:core needs explicit TEST_DATABASE_URL for its boot check');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn('./node_modules/.bin/tsx', ['apps/api/src/index.ts'], {
    env: {
      ...env,
      DATABASE_URL: env.TEST_DATABASE_URL,
      API_PORT: String(port),
      TOKEN_SIGNING_KEY: '6'.repeat(64),
      PROVIDER_TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
      LLM_API_KEY: 'sk-core-test',
      LLM_BASE_URL: 'http://127.0.0.1:1/v1',
      FEISHU_BOT_ENABLED: '0',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  let exited = false;
  const exit = once(child, 'exit').then(() => {
    exited = true;
  });
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Core boot exited early:\n${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          console.log('✓ core boot: /health returns 200 with plugins: []');
          return;
        }
      } catch {
        /* wait for boot */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Core boot timed out:\n${logs}`);
  } finally {
    if (!exited) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit;
    clearTimeout(timer);
  }
}
try {
  await run(['plugins:sync']);
  await run(['exec', 'tsc', '--noEmit', '--incremental', '-p', 'tsconfig.core.json']);
  await run(['exec', 'vitest', 'run']);
  await run(['plugins:sync', '--check']);
  await smoke();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await run(['plugins:sync'], process.env);
}
