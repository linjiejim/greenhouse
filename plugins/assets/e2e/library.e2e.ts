import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { grantFeature, openHosted } from '../../../tests/client-e2e/plugin-kit';

/**
 * The asset library in a real browser: a picture chosen in the embed is hashed, thumbnailed and
 * published through the plugin object store, shows in the grid, and the same bytes again are
 * recognised as already there instead of stored twice.
 */

/** A small PNG of random colours, so every run uploads bytes the library has not seen. */
function picture(width = 64, height = 48): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const colours = randomBytes(9);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const band = Math.floor((x / width) * 3) * 3;
      rows.set(colours.subarray(band, band + 3), y * (width * 3 + 1) + 1 + x * 3);
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('Assets: an uploaded picture shows in the library, and the same bytes again are a duplicate', async ({ page }) => {
  await grantFeature(page, 'assets');
  await openHosted(page, '/p/assets/assets');
  const frame = page.frameLocator('iframe');
  const name = `e2e-${Date.now().toString(36)}.png`;
  const buffer = picture();

  await frame.getByTestId('assets-files-input').setInputFiles({ name, mimeType: 'image/png', buffer });
  await frame.getByTestId('assets-start-upload').click();
  await expect(frame.getByTestId('assets-upload-queue')).toContainText(/1 added|新增 1/, { timeout: 60_000 });
  await expect(frame.getByTestId('assets-grid')).toContainText(name.replace(/\.png$/, ''));

  await frame.getByTestId('assets-files-input').setInputFiles({ name: `again-${name}`, mimeType: 'image/png', buffer });
  await frame.getByTestId('assets-start-upload').click();
  await expect(frame.getByTestId('assets-upload-queue')).toContainText(/1 already there|已存在 1/, { timeout: 60_000 });
});
