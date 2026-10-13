/**
 * The E2B computer template as the provider receives it (no network): the Dockerfile without its
 * entrypoint and with the provider's account moved off uid 1000, the hosted layer copied in, the
 * hardening as the start command, and a name that follows the content.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Template } from 'e2b';
import { describe, expect, it } from 'vitest';
import { COMPUTER_CONTEXT_DIR, computerTemplate, computerTemplateName, hostedDockerfile } from '../e2b-template.js';

const SIZE = { cpuCount: 2, memoryMB: 2048 };

describe('the E2B computer template', () => {
  it('drops the entrypoint and moves the provider’s account off the agent’s uid first thing', () => {
    const dockerfile = hostedDockerfile(readFileSync(join(COMPUTER_CONTEXT_DIR, 'Dockerfile'), 'utf8'));
    expect(dockerfile).not.toMatch(/^ENTRYPOINT/m);
    const lines = dockerfile.split('\n');
    const from = lines.findIndex((line) => line.startsWith('FROM '));
    expect(lines[from + 1]).toContain('usermod -u 2000 user');
    expect(() => hostedDockerfile('FROM debian\nRUN true\n')).toThrow('changed shape');
  });

  it('copies the bridges and their units in and hardens as its start command', async () => {
    const steps = await Template.toJSON(computerTemplate(SIZE), false);
    for (const path of [
      '/opt/gh-bridge/gh-bridge.mjs',
      '/usr/local/sbin/gh-e2b-boot',
      '/usr/local/sbin/gh-e2b-harden',
      '/etc/systemd/system/gh-bridge-agent.socket',
      '/etc/systemd/system/gh-desktop.service',
    ]) {
      expect(steps).toContain(path);
    }
    expect(steps).toContain('ws@8.21.0');
    expect(steps).toContain('test -f /var/lib/gh-computer/hardened');
  });

  it('is named after its content and its size', async () => {
    const name = await computerTemplateName(SIZE);
    expect(name).toMatch(/^gh-computer-[0-9a-f]{12}$/);
    expect(await computerTemplateName(SIZE)).toBe(name);
    expect(await computerTemplateName({ ...SIZE, memoryMB: 4096 })).not.toBe(name);
    const copy = mkdtempSync(join(tmpdir(), 'gh-computer-'));
    try {
      cpSync(COMPUTER_CONTEXT_DIR, copy, { recursive: true });
      expect(await computerTemplateName({ ...SIZE, contextDir: copy })).toBe(name);
      writeFileSync(join(copy, 'e2b', 'gh-e2b-boot'), '#!/bin/bash\nexit 0\n');
      expect(await computerTemplateName({ ...SIZE, contextDir: copy })).not.toBe(name);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
