import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { QUIESCE_SCRIPT, RESTORE_SCRIPT } from '../backups.js';

it('quiesces account processes while keeping the command and its bridge ancestors responsive', () => {
  const output = execFileSync('python3', [
    '-c',
    `import builtins, io, json, os, types
stopped = []
parents = {90: 80, 80: 1}
builtins.open = lambda path: io.StringIO('PPid: '+str(parents[int(path.split('/')[2])])+'\\n')
os.getpid = lambda: 100
os.getppid = lambda: 90
os.getuid = lambda: 1000
os.listdir = lambda path: ['1', '80', '90', '100', '200', '300', 'self']
os.stat = lambda path: types.SimpleNamespace(st_uid=1001 if path == '/proc/300' else 1000)
os.kill = lambda pid, sig: stopped.append(pid)
${QUIESCE_SCRIPT}
print(json.dumps(stopped))
`,
  ]);
  expect(JSON.parse(output.toString())).toEqual([200]);
});

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
