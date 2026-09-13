import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../../scripts/sandbox-runner-quota.sh', import.meta.url));
// These cases spawn several shell fixtures. They finish in ~1–4s alone but can
// exceed Vitest's 5s default while the full repository suite is CPU-bound.
const ATTEST_TIMEOUT_MS = 15_000;
let tempRoot: string | null = null;

async function executable(path: string, source: string): Promise<string> {
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
  return path;
}

interface FixtureOptions {
  duplicateProject?: boolean;
  hardKiB?: number;
  mechanism?: 'xfs-project' | 'ext4-project';
}

async function fixture(options: FixtureOptions = {}) {
  tempRoot = await mkdtemp(join(tmpdir(), 'mission-quota-script-'));
  const dataRoot = join(tempRoot, 'data');
  const userHome = join(dataRoot, 'homes', 'user_1');
  await mkdir(userHome, { recursive: true });
  await mkdir(join(dataRoot, 'homes', 'user_2'), { recursive: true });
  const bin = join(tempRoot, 'bin');
  await mkdir(bin);

  const fsType = options.mechanism === 'ext4-project' ? 'ext4' : 'xfs';
  const findmnt = await executable(
    join(bin, 'findmnt'),
    `#!/usr/bin/env bash
case "\${!#}" in
  TARGET) echo /fake-mount ;;
  FSTYPE) echo ${fsType} ;;
  OPTIONS) echo rw,pquota ;;
  *) exit 2 ;;
esac
`,
  );
  const xfsIo = await executable(
    join(bin, 'xfs_io'),
    `#!/usr/bin/env bash
leaf="$(basename "\${!#}")"
if [ "$leaf" = user_1 ]; then id=100001; else id=${options.duplicateProject ? '100001' : '100002'}; fi
echo "fsxattr.projid = $id"
echo "fsxattr.xflags = 0x200 [proj-inherit]"
`,
  );
  const xfsQuota = await executable(
    join(bin, 'xfs_quota'),
    `#!/usr/bin/env bash
case "$3" in
  *" -b "*) echo "#100001 0 0 ${options.hardKiB ?? 5} 00 [--------]" ; echo "#100002 0 0 5 00 [--------]" ;;
  *" -i "*) echo "#100001 0 0 25 00 [--------]" ; echo "#100002 0 0 25 00 [--------]" ;;
  *) exit 2 ;;
esac
`,
  );
  const lsattr = await executable(
    join(bin, 'lsattr'),
    `#!/usr/bin/env bash
leaf="$(basename "\${!#}")"
if [ "$leaf" = user_1 ]; then id=200001; else id=${options.duplicateProject ? '200001' : '200002'}; fi
echo "----------------------P------- $id \${!#}"
`,
  );
  const repquota = await executable(
    join(bin, 'repquota'),
    `#!/usr/bin/env bash
echo '"#200001","0","0","${options.hardKiB ?? 5}","","1","0","25",""'
echo '"#200002","0","0","5","","1","0","25",""'
`,
  );

  return {
    dataRoot,
    userHome,
    env: {
      ...process.env,
      FINDMNT_BIN: findmnt,
      XFS_IO_BIN: xfsIo,
      XFS_QUOTA_BIN: xfsQuota,
      LSATTR_BIN: lsattr,
      REPQUOTA_BIN: repquota,
    },
  };
}

async function attest(options: FixtureOptions = {}) {
  const test = await fixture(options);
  return execFileAsync(
    SCRIPT,
    [
      'attest',
      '--data-root',
      test.dataRoot,
      '--user-id',
      'user_1',
      '--path',
      test.userHome,
      '--limit-bytes',
      '5120',
      '--inode-limit',
      '25',
      '--mechanism',
      options.mechanism ?? 'xfs-project',
    ],
    { env: test.env },
  );
}

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('sandbox-runner-quota ops attester', () => {
  it(
    'emits live proof only after project id, inheritance, uniqueness and both hard limits match',
    async () => {
      const { stdout } = await attest();
      expect(JSON.parse(String(stdout))).toMatchObject({
        version: 1,
        user_id: 'user_1',
        scope: 'per-user',
        mechanism: 'xfs-project',
        project_id: 100001,
        limit_bytes: 5120,
        inode_limit: 25,
        project_inherit: true,
        exclusive: true,
      });
    },
    ATTEST_TIMEOUT_MS,
  );

  it(
    'fails closed when another user home has the same project id',
    async () => {
      await expect(attest({ duplicateProject: true })).rejects.toThrow(/shared with another user home/);
    },
    ATTEST_TIMEOUT_MS,
  );

  it(
    'fails closed when the kernel byte hard limit differs',
    async () => {
      await expect(attest({ hardKiB: 4 })).rejects.toThrow(/byte hard limit does not match/);
    },
    ATTEST_TIMEOUT_MS,
  );

  it(
    'attests ext4 project id, inherit flag and CSV hard limits through the same contract',
    async () => {
      const { stdout } = await attest({ mechanism: 'ext4-project' });
      expect(JSON.parse(String(stdout))).toMatchObject({
        mechanism: 'ext4-project',
        project_id: 200001,
        limit_bytes: 5120,
        inode_limit: 25,
        project_inherit: true,
        exclusive: true,
      });
    },
    ATTEST_TIMEOUT_MS,
  );

  it('is syntactically valid and documents its interface', async () => {
    await expect(execFileAsync('bash', ['-n', SCRIPT])).resolves.toBeDefined();
    const { stdout } = await execFileAsync(SCRIPT, ['--help']);
    expect(String(stdout)).toContain('attest');
    expect(String(stdout)).toContain('bootstrap');
  });
});
