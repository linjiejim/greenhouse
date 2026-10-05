import { describe, expect, it } from 'vitest';

import { filterSetEncodings, MAX_CUT_TEXT_BYTES, RfbClientFilter, rfbMessageLength } from './rfb-filter.js';

const VERSION = Buffer.from('RFB 003.008\n');

function keyEvent(down: boolean, keysym: number): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = down ? 1 : 0;
  b.writeUInt32BE(keysym, 4);
  return b;
}

function pointer(mask: number, x: number, y: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = 5;
  b[1] = mask;
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  return b;
}

function cutText(text: string, extended = false): Buffer {
  const payload = Buffer.from(text);
  const b = Buffer.alloc(8);
  b[0] = 6;
  b.writeInt32BE(extended ? -payload.length : payload.length, 4);
  return Buffer.concat([b, payload]);
}

function setEncodings(encodings: number[]): Buffer {
  const b = Buffer.alloc(4 + 4 * encodings.length);
  b[0] = 2;
  b.writeUInt16BE(encodings.length, 2);
  encodings.forEach((e, i) => b.writeInt32BE(e, 4 + 4 * i));
  return b;
}

const fbUpdateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const setPixelFormat = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(16, 7)]);
const enableContinuous = Buffer.from([150, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const fence = Buffer.concat([Buffer.from([248, 0, 0, 0, 0, 0, 0, 3, 4]), Buffer.from('abcd')]);
const qemuKey = (down: boolean) => {
  const b = Buffer.alloc(12);
  b[0] = 255;
  b[1] = 0;
  b.writeUInt16BE(down ? 1 : 0, 2);
  b.writeUInt32BE(0x61, 4);
  b.writeUInt32BE(30, 8);
  return b;
};

/** Feed `stream` one byte at a time (the worst WebSocket chunking). */
function feedBytewise(filter: RfbClientFilter, stream: Buffer) {
  const forward: Buffer[] = [];
  let close: string | undefined;
  for (const byte of stream) {
    const result = filter.push(Buffer.from([byte]));
    forward.push(...result.forward);
    close ??= result.close;
  }
  return { forward: Buffer.concat(forward), close };
}

function handshake(): Buffer {
  return Buffer.concat([VERSION, Buffer.from([1]), Buffer.from([0])]);
}

describe('RFB client filter', () => {
  it('passes the handshake across arbitrary chunks and forces a shared session', () => {
    const filter = new RfbClientFilter(() => false);
    const { forward, close } = feedBytewise(filter, handshake());
    expect(close).toBeUndefined();
    expect(forward).toEqual(Buffer.concat([VERSION, Buffer.from([1]), Buffer.from([1])]));
  });

  it('frames every display message and forwards it whole, split or batched', () => {
    const filter = new RfbClientFilter(() => false);
    const display = Buffer.concat([
      setPixelFormat,
      setEncodings([7, 16, 0, -223, -308]),
      fbUpdateRequest,
      enableContinuous,
      fence,
      Buffer.from([250, 0, 1, 2]),
    ]);
    const all = Buffer.concat([handshake(), display]);
    expect(feedBytewise(filter, all).forward).toEqual(Buffer.concat([VERSION, Buffer.from([1, 1]), display]));

    const batched = new RfbClientFilter(() => false);
    const result = batched.push(all);
    expect(result.close).toBeUndefined();
    expect(Buffer.concat(result.forward)).toEqual(Buffer.concat([VERSION, Buffer.from([1, 1]), display]));
  });

  it('drops keyboard, mouse, clipboard, resize and QEMU input unless input is allowed', () => {
    let allowed = false;
    const filter = new RfbClientFilter(() => allowed);
    filter.push(handshake());
    const resize = Buffer.concat([Buffer.from([251, 0, 5, 0, 3, 32, 1, 0]), Buffer.alloc(16)]);
    const input = Buffer.concat([keyEvent(true, 0x61), pointer(1, 10, 20), cutText('secret'), resize, qemuKey(true)]);
    expect(filter.push(Buffer.concat([input, fbUpdateRequest])).forward).toEqual([fbUpdateRequest]);

    allowed = true;
    expect(Buffer.concat(filter.push(input).forward)).toEqual(input);
  });

  it('follows the lease per message, even within one chunk', () => {
    let allowed = true;
    const filter = new RfbClientFilter(() => allowed);
    filter.push(handshake());
    const first = filter.push(keyEvent(true, 0x62));
    allowed = false;
    const second = filter.push(keyEvent(false, 0x62));
    expect(first.forward).toHaveLength(1);
    expect(second.forward).toHaveLength(0);
  });

  it('reads ClientCutText length as int32 and accepts Extended Clipboard (negative) lengths', () => {
    const filter = new RfbClientFilter(() => true);
    filter.push(handshake());
    const extended = cutText('\u0000\u0000\u0000\u0001zlibdata', true);
    const after = fbUpdateRequest;
    const result = feedBytewise(filter, Buffer.concat([extended, after]));
    expect(result.close).toBeUndefined();
    expect(result.forward).toEqual(Buffer.concat([extended, after]));
  });

  it('closes on an oversized clipboard, an unknown message, a bad version or a non-None security type', () => {
    const huge = Buffer.alloc(8);
    huge[0] = 6;
    huge.writeInt32BE(MAX_CUT_TEXT_BYTES + 1, 4);
    const filter = new RfbClientFilter(() => true);
    filter.push(handshake());
    expect(filter.push(huge).close).toMatch(/clipboard/);
    expect(filter.push(fbUpdateRequest)).toEqual({ forward: [], close: 'closed' });

    const unknown = new RfbClientFilter(() => true);
    unknown.push(handshake());
    expect(unknown.push(Buffer.from([7, 0, 0, 0])).close).toMatch(/unknown message type 7/);

    expect(new RfbClientFilter(() => true).push(Buffer.from('RFB 004.000\n')).close).toMatch(/version/);
    const vncAuth = new RfbClientFilter(() => true);
    expect(vncAuth.push(Buffer.concat([VERSION, Buffer.from([2])])).close).toMatch(/security/);

    const qemu = new RfbClientFilter(() => true);
    qemu.push(handshake());
    expect(qemu.push(Buffer.from([255, 9])).close).toMatch(/QEMU/);
  });

  it('supports RFB 3.3, where the client sends no security choice', () => {
    const filter = new RfbClientFilter(() => false);
    const v33 = Buffer.from('RFB 003.003\n');
    const result = feedBytewise(filter, Buffer.concat([v33, Buffer.from([0]), fbUpdateRequest]));
    expect(result.forward).toEqual(Buffer.concat([v33, Buffer.from([1]), fbUpdateRequest]));
  });

  it('releases held keys and buttons when input is taken away', () => {
    const filter = new RfbClientFilter(() => true);
    filter.push(handshake());
    filter.push(
      Buffer.concat([
        keyEvent(true, 0xffe1),
        keyEvent(true, 0x41),
        keyEvent(false, 0x41),
        pointer(1, 100, 200),
        qemuKey(true),
      ]),
    );
    const release = Buffer.concat(filter.releaseInput());
    expect(release).toEqual(
      Buffer.concat([keyEvent(false, 0xffe1), Buffer.from(qemuKey(false)), pointer(0, 100, 200)]),
    );
    expect(filter.releaseInput()).toEqual([]);
  });

  describe('pseudo-encodings that change client framing (ExtendedMouseButtons)', () => {
    const EXTENDED_MOUSE = -316;
    // What noVNC 1.7 sends (core/rfb.js _sendEncodings), quality 6 / compression 2.
    const NOVNC = [1, 7, -260, 16, 21, 5, 2, 6, 0, -26, -254, -223, -224, -258, -261, -308, -309, -312, -313, -307];
    const novncEncodings = [...NOVNC, 0xc0a1e5ce | 0, EXTENDED_MOUSE, 0x574d5664, -239];

    /** Frame forwarded client bytes the way Xvnc does, given the encodings it was actually sent. */
    function xvncMessages(stream: Buffer): Buffer[] {
      let extendedMouse = false;
      const out: Buffer[] = [];
      let rest = stream.subarray(12 + 1 + 1); // version, security, ClientInit
      while (rest.length > 0) {
        let length = rfbMessageLength(rest);
        if (typeof length !== 'number') throw new Error(`unframeable: ${String(length)}`);
        if (rest[0] === 5 && extendedMouse && rest[1]! & 0x80) length = 7;
        const message = rest.subarray(0, length);
        if (message[0] === 2) {
          const count = message.readUInt16BE(2);
          const encodings = Array.from({ length: count }, (_, i) => message.readInt32BE(4 + 4 * i));
          extendedMouse = encodings.includes(EXTENDED_MOUSE);
        }
        out.push(message);
        rest = rest.subarray(length);
      }
      return out;
    }

    it('strips ExtendedMouseButtons (and any pseudo-encoding it cannot frame) from SetEncodings', () => {
      const filter = new RfbClientFilter(() => false);
      const { forward, close } = feedBytewise(filter, Buffer.concat([handshake(), setEncodings(novncEncodings)]));
      expect(close).toBeUndefined();
      const sent = xvncMessages(forward);
      expect(sent).toEqual([setEncodings([...NOVNC, 0xc0a1e5ce | 0, 0x574d5664, -239])]);

      // gii (-305) and QEMU pointer-motion-change (-257) are unknown here: removed too.
      expect(filterSetEncodings(setEncodings([7, -305, -257, -223]))).toEqual(setEncodings([7, -223]));
      // Nothing to remove: the very same message goes through.
      const plain = setEncodings([7, 0, -223]);
      expect(filterSetEncodings(plain)).toBe(plain);
    });

    it('frames a 6-byte pointer with the marker bit set as 6 bytes when -316 was never enabled', () => {
      const filter = new RfbClientFilter(() => true);
      const stream = Buffer.concat([
        handshake(),
        setEncodings(novncEncodings),
        pointer(0x81, 10, 20),
        keyEvent(true, 0x61),
      ]);
      const { forward, close } = feedBytewise(filter, stream);
      expect(close).toBeUndefined();
      const sent = xvncMessages(forward);
      expect(sent.slice(1)).toEqual([pointer(0x81, 10, 20), keyEvent(true, 0x61)]);
    });

    it('never lets a forwarded message turn into a KeyEvent on the server while the member only watches', () => {
      let allowed = true;
      const filter = new RfbClientFilter(() => allowed);
      const out: Buffer[] = [];
      const push = (bytes: Buffer) => {
        const result = filter.push(bytes);
        expect(result.close).toBeUndefined();
        out.push(...result.forward);
      };
      push(Buffer.concat([handshake(), setEncodings(novncEncodings)]));
      // While the member holds the lease: a pointer event with the extended marker bit.
      push(pointer(0x80, 10, 20));
      allowed = false;
      // Watching only: a FramebufferUpdateRequest whose bytes 1-8 spell KeyEvent(down, 'a').
      const smuggle = Buffer.from([3, 4, 1, 0, 0, 0, 0, 0, 0x61, 0]);
      push(smuggle);

      const forwarded = Buffer.concat(out);
      const sent = xvncMessages(forwarded);
      expect(sent.slice(1)).toEqual([pointer(0x80, 10, 20), smuggle]);
      expect(sent.some((m) => m[0] === 4)).toBe(false);

      // The same bytes with -316 left in SetEncodings is exactly the attack: Xvnc
      // takes the request's first byte as the 7th pointer byte and runs a KeyEvent.
      const unfiltered = Buffer.concat([
        forwarded.subarray(0, 14),
        setEncodings(novncEncodings),
        pointer(0x80, 10, 20),
        smuggle,
      ]);
      expect(xvncMessages(unfiltered).some((m) => m[0] === 4)).toBe(true);
    });
  });

  it('knows each message length (null = need more)', () => {
    expect(rfbMessageLength(Buffer.from([2, 0]))).toBeNull();
    expect(rfbMessageLength(Buffer.from([2, 0, 0, 3]))).toBe(16);
    expect(rfbMessageLength(Buffer.from([255, 1, 0, 2]))).toBe(10);
    expect(rfbMessageLength(Buffer.from([255, 1, 0, 0]))).toBe(4);
    expect(rfbMessageLength(Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 65]))).toMatch(/fence/);
    expect(rfbMessageLength(Buffer.alloc(0))).toBeNull();
  });
});
