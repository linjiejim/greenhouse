/**
 * The file routes against the in-memory sandbox: what reaches the computer (paths as arguments,
 * never above the home), how its answers come back, and who may ask. The scripts themselves run
 * against the real image in sockets.live.db.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { DELETE_SCRIPT, DOWNLOAD_SCRIPT, LIST_SCRIPT, UPLOAD_SCRIPT } from '../files.js';
import { createTestApp } from '../../../testing.js';
import { fake, fakeSandboxEnv } from './fake-sandbox.js';

async function setup() {
  const app = createTestApp(fakeSandboxEnv());
  const lin = await app.member();
  const calls: Array<{ script: string; args: string[] }> = [];
  fake.exec = (_name, input) => {
    calls.push({ script: input.argv[2]!, args: input.argv.slice(4) });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const raw = (method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
    app.app.request(path, {
      method,
      headers: { authorization: `Bearer ${lin.token}`, ...init.headers },
      ...(init.body ? { body: init.body } : {}),
    });
  return { ...app, lin, calls, raw };
}

describe('files in the computer home', () => {
  it('lists a folder: the path goes as an argument, the answer comes back as entries', async () => {
    const { call, lin, calls } = await setup();
    fake.exec = (_name, input) => {
      calls.push({ script: input.argv[2]!, args: input.argv.slice(4) });
      return {
        exitCode: 0,
        stdout: ['d\t4096\t1760000000\tdrafts', 'f\t12\t1760000001\treport.pdf', ''].join('\0'),
        stderr: '',
        timedOut: false,
      };
    };
    const listed = await call('GET', '/api/agents/main/computer/files?path=work', { token: lin.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      path: 'work',
      items: [
        { name: 'drafts', type: 'dir', size: 0, modified_at: new Date(1760000000000).toISOString() },
        { name: 'report.pdf', type: 'file', size: 12, modified_at: new Date(1760000001000).toISOString() },
      ],
      truncated: false,
    });
    expect(calls).toEqual([{ script: LIST_SCRIPT, args: ['/home/agent/work', '500'] }]);
  });

  it('refuses paths above or outside the home before the computer is asked', async () => {
    const { call, lin, calls } = await setup();
    for (const path of ['..', 'work/../../browser', '/etc', '%2Fetc']) {
      const response = await call('GET', `/api/agents/main/computer/files?path=${path}`, { token: lin.token });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('path_outside_home');
    }
    expect(calls).toEqual([]);
    // A link that leads out is caught inside the computer, on the real path.
    fake.exec = () => ({ exitCode: 5, stdout: '', stderr: 'That leads out of the home folder.\n', timedOut: false });
    const link = await call('GET', '/api/agents/main/computer/files?path=work/link', { token: lin.token });
    expect(link.body.error).toEqual({ code: 'path_outside_home', message: 'That leads out of the home folder.' });
    fake.exec = () => ({ exitCode: 3, stdout: '', stderr: 'No such file or folder.\n', timedOut: false });
    expect((await call('GET', '/api/agents/main/computer/files?path=nope', { token: lin.token })).status).toBe(404);
  });

  it('downloads a file as an attachment, whatever it holds', async () => {
    const { raw } = await setup();
    fake.onStream = (stream) => {
      if (stream.argv[2] !== DOWNLOAD_SCRIPT) return;
      expect(stream.argv.slice(4)).toEqual(['/home/agent/work/page.html', String(1024 ** 3)]);
      stream.output.write('15\n<script>1</');
      stream.output.write('script>');
      stream.exit(0);
    };
    const response = await raw('GET', '/api/agents/main/computer/files/content?path=work/page.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="page.html"/);
    expect(response.headers.get('content-length')).toBe('15');
    expect(await response.text()).toBe('<script>1</scri');

    fake.onStream = (stream) => {
      stream.errors.write('Not a file.\n');
      stream.exit(4);
    };
    const folder = await raw('GET', '/api/agents/main/computer/files/content?path=work');
    expect(folder.status).toBe(400);
    expect(((await folder.json()) as { error: { message: string } }).error.message).toBe('Not a file.');
  });

  it('uploads into a folder under a free name, and caps the size', async () => {
    const { raw } = await setup();
    let received: Buffer = Buffer.alloc(0);
    let args: string[] = [];
    fake.onStream = (stream) => {
      if (stream.argv[2] !== UPLOAD_SCRIPT) return;
      args = stream.argv.slice(4);
      stream.input.on('end', () => {
        received = stream.written();
        stream.output.write(`${received.length}\t1760000002\tnotes (1).md\n`);
        stream.exit(0);
      });
    };
    const form = new FormData();
    form.set('file', new File(['# hello'], '../../notes.md', { type: 'text/markdown' }));
    const response = await raw('POST', '/api/agents/main/computer/files?path=work', { body: form });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      name: 'notes (1).md',
      type: 'file',
      size: 7,
      modified_at: new Date(1760000002000).toISOString(),
    });
    expect(args).toEqual(['/home/agent/work', 'notes', '.md', '7']);
    expect(received.toString()).toBe('# hello');

    const huge = await raw('POST', '/api/agents/main/computer/files?path=work', {
      body: 'x',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(60 * 1024 * 1024) },
    });
    expect(huge.status).toBe(413);
  });

  it('deletes a file or a folder, never the home itself', async () => {
    const { call, lin, calls } = await setup();
    expect((await call('DELETE', '/api/agents/main/computer/files?path=work/old', { token: lin.token })).status).toBe(
      204,
    );
    expect(calls).toEqual([{ script: DELETE_SCRIPT, args: ['/home/agent/work/old'] }]);
    const home = await call('DELETE', '/api/agents/main/computer/files?path=', { token: lin.token });
    expect(home.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('belong to the member whose computer it is', async () => {
    const { call, lin, member } = await setup();
    const main = (await call('GET', '/api/agents/main', { token: lin.token })).body;
    const chen = await member();
    expect((await call('GET', `/api/agents/${main.id}/computer/files`, { token: chen.token })).status).toBe(404);
    expect(
      (await call('DELETE', `/api/agents/${main.id}/computer/files?path=work`, { token: chen.token })).status,
    ).toBe(404);
  });
});
