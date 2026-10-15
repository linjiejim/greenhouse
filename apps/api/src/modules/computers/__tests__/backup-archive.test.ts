import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RESTORE_SCRIPT } from '../backups.js';

it.each(['../escape', '/absolute', 'unsafe-link'])('rejects %s before changing an existing home', (name) => {
  const home = mkdtempSync(join(process.cwd(), 'node_modules/.cache/t12-archive-'));
  try {
    writeFileSync(join(home, 'original'), 'kept');
    const archive = execFileSync('python3', [
      '-c',
      `import io, sys, tarfile
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz') as t:
 e=tarfile.TarInfo(sys.argv[1])
 if sys.argv[1]=='unsafe-link': e.type=tarfile.SYMTYPE; e.linkname='/etc/passwd'
 else: e.size=4
 t.addfile(e,io.BytesIO(b'bad!'))
`,
      name,
    ]);
    const result = spawnSync('python3', ['-c', RESTORE_SCRIPT], { cwd: home, input: archive });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(home, 'original'), 'utf8')).toBe('kept');
  } finally {
    rmSync(home, { recursive: true });
  }
});
