/** Build an HFS+ UDZO image without mounting a device or invoking Finder. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
export function buildDmg({ desktop, root, env }) {
  const output = join(desktop, 'src-tauri/target/release/bundle/dmg');
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(output, '.stage-'));
  const image = join(temporary, 'volume.hfs.dmg');
  const stage = join(temporary, 'Greenhouse');
  mkdirSync(stage);
  const run = (command, args) => {
    const result = spawnSync(command, args, { env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  };
  try {
    run('ditto', [
      join(desktop, 'src-tauri/target/release/bundle/macos/Greenhouse.app'),
      join(stage, 'Greenhouse.app'),
    ]);
    symlinkSync('/Applications', join(stage, 'Applications'));
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
    const destination = join(output, `Greenhouse_${version}_${arch}.dmg`);
    run('hdiutil', ['makehybrid', '-hfs', '-hfs-volume-name', 'Greenhouse', '-o', image, stage]);
    run('hdiutil', ['convert', image, '-format', 'UDZO', '-ov', '-o', destination]);
    run('hdiutil', ['verify', destination]);
    if (env.GREENHOUSE_DESKTOP_SIGNING_IDENTITY)
      run('codesign', ['--force', '--timestamp', '--sign', env.GREENHOUSE_DESKTOP_SIGNING_IDENTITY, destination]);
    console.log(`Built disk image: ${destination}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
