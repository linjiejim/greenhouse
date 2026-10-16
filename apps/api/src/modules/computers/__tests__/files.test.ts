import { describe, expect, it } from 'vitest';
import { homePath, parseListing, parseUploaded, scriptError, splitName, uploadName } from '../files.js';
import { resizeFrame, TERMINAL_FRAME, terminalFrame } from '../terminal.js';

describe('paths in the home', () => {
  it('are relative to the home, normalised, and never above it', () => {
    expect(homePath('')).toEqual({ rel: '', abs: '/home/agent' });
    expect(homePath('.')).toEqual({ rel: '', abs: '/home/agent' });
    expect(homePath('work/report.pdf')).toEqual({ rel: 'work/report.pdf', abs: '/home/agent/work/report.pdf' });
    expect(homePath('work//./notes/')).toEqual({ rel: 'work/notes', abs: '/home/agent/work/notes' });
    expect(homePath('dir with spaces/文件.txt').abs).toBe('/home/agent/dir with spaces/文件.txt');
    expect(homePath('..hidden')).toEqual({ rel: '..hidden', abs: '/home/agent/..hidden' });
  });

  it('refuse absolute paths, `..` and control characters', () => {
    expect(() => homePath('/etc/passwd')).toThrow(expect.objectContaining({ code: 'path_outside_home' }));
    expect(() => homePath('..')).toThrow(expect.objectContaining({ code: 'path_outside_home' }));
    expect(() => homePath('work/../../browser')).toThrow(expect.objectContaining({ code: 'path_outside_home' }));
    expect(() => homePath('work/a\nb')).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => homePath('work/\u0000')).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => homePath('a'.repeat(4097))).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('upload names', () => {
  it('keep a plain name with its extension, and never a path or a dot name', () => {
    expect(splitName('report.final.pdf')).toEqual({ base: 'report.final', ext: '.pdf' });
    expect(splitName('.env')).toEqual({ base: '.env', ext: '' });
    expect(uploadName('../../etc/passwd')).toEqual({ base: 'passwd', ext: '' });
    expect(uploadName('C:\\Users\\me\\photo.jpg')).toEqual({ base: 'photo', ext: '.jpg' });
    expect(uploadName('..')).toEqual({ base: 'file', ext: '' });
    expect(uploadName('.gh-upload.abc')).toEqual({ base: 'file', ext: '' });
    expect(uploadName('a\u0000b.txt')).toEqual({ base: 'ab', ext: '.txt' });
  });

  it('fit the file system in bytes, keeping the extension', () => {
    const { base, ext } = uploadName(`${'文'.repeat(150)}.txt`);
    expect(ext).toBe('.txt');
    expect(Buffer.byteLength(base + ext)).toBeLessThanOrEqual(200);
  });
});

describe('what the file scripts print', () => {
  it('lists folders and files, skipping uploads in flight and unreadable records', () => {
    const stdout = [
      'd\t4096\t1760000000.5\tnotes',
      'f\t12\t1760000001\treport.pdf',
      'l\t9\t1760000002\tbroken link',
      'f\t3\t1760000003\t.gh-upload.x1y2',
      'garbage',
      'f\t5\t1760000004\ttab\tin name',
      '',
    ].join('\0');
    const { items, truncated } = parseListing(stdout);
    expect(truncated).toBe(false);
    expect(items).toEqual([
      { name: 'notes', type: 'dir', size: 0, modified_at: new Date(1760000000500).toISOString() },
      { name: 'report.pdf', type: 'file', size: 12, modified_at: new Date(1760000001000).toISOString() },
      { name: 'broken link', type: 'file', size: 9, modified_at: new Date(1760000002000).toISOString() },
      { name: 'tab\tin name', type: 'file', size: 5, modified_at: new Date(1760000004000).toISOString() },
    ]);
    const many = Array.from({ length: 3 }, (_, i) => `f\t1\t1\tf${i}`).join('\0');
    expect(parseListing(many, 2)).toMatchObject({ truncated: true, items: [{ name: 'f0' }, { name: 'f1' }] });
  });

  it('says where an upload landed', () => {
    expect(parseUploaded('12\t1760000001\treport (1).pdf\n')).toEqual({
      name: 'report (1).pdf',
      type: 'file',
      size: 12,
      modified_at: new Date(1760000001000).toISOString(),
    });
    expect(parseUploaded('')).toBeNull();
  });

  it('turn exits into the errors the routes answer with', () => {
    expect(scriptError(3, '')).toMatchObject({ status: 404, code: 'not_found' });
    expect(scriptError(4, 'Not a folder.\n')).toMatchObject({
      status: 400,
      code: 'invalid_input',
      message: 'Not a folder.',
    });
    expect(scriptError(5, 'out')).toMatchObject({ status: 400, code: 'path_outside_home' });
    expect(scriptError(7, 'big')).toMatchObject({ status: 413, code: 'too_large' });
    expect(scriptError(8, 'short')).toMatchObject({ status: 400, code: 'upload_incomplete' });
    expect(scriptError(137, '')).toMatchObject({ status: 502, code: 'computer_error' });
  });
});

describe('terminal frames', () => {
  it('carry keystrokes and clamped resizes in the framing gh-term reads', () => {
    expect(terminalFrame(TERMINAL_FRAME.data, Buffer.from('ls\r'))).toEqual(
      Buffer.from([0, 0, 0, 0, 3, ...Buffer.from('ls\r')]),
    );
    const resize = resizeFrame(JSON.stringify({ type: 'resize', cols: 9999, rows: 1 }))!;
    expect(resize[0]).toBe(TERMINAL_FRAME.resize);
    expect(resize.readUInt32BE(1)).toBe(resize.length - 5);
    expect(JSON.parse(resize.subarray(5).toString())).toEqual({ cols: 500, rows: 5 });
    expect(resizeFrame('{"type":"resize","cols":80}')).toBeNull();
    expect(resizeFrame('{"type":"paste","cols":80,"rows":24}')).toBeNull();
    expect(resizeFrame('not json')).toBeNull();
    expect(resizeFrame(`{"type":"resize","cols":80,"rows":24,"pad":"${'x'.repeat(300)}"}`)).toBeNull();
  });
});
