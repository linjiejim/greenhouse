import { describe, expect, it } from 'vitest';
import { filterSetEncodings, MAX_CUT_TEXT_BYTES, RfbClientFilter, rfbMessageLength } from '../rfb.js';

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

/** Feeds `stream` one byte at a time, the worst WebSocket chunking. */
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

/** ProtocolVersion, security None, ClientInit asking for exclusive access. */
const handshake = () => Buffer.concat([VERSION, Buffer.from([1]), Buffer.from([0])]);

describe('the RFB client filter', () => {
  it('passes the handshake across any chunking and always asks for a shared session', () => {
    const filter = new RfbClientFilter(false);
    const { forward, close } = feedBytewise(filter, handshake());
    expect(close).toBeUndefined();
    expect(forward).toEqual(Buffer.concat([VERSION, Buffer.from([1]), Buffer.from([1])]));
  });

  it('frames every display message and forwards it whole, split or batched', () => {
    const display = Buffer.concat([
      setPixelFormat,
      setEncodings([7, 16, 0, -223, -308]),
      fbUpdateRequest,
      enableContinuous,
      fence,
      Buffer.from([250, 0, 1, 2]),
    ]);
    const all = Buffer.concat([handshake(), display]);
    const expected = Buffer.concat([VERSION, Buffer.from([1, 1]), display]);
    expect(feedBytewise(new RfbClientFilter(false), all).forward).toEqual(expected);

    const batched = new RfbClientFilter(false).push(all);
    expect(batched.close).toBeUndefined();
    expect(Buffer.concat(batched.forward)).toEqual(expected);
  });

  it('drops keys, clicks, clipboard, resizes and QEMU input on a view ticket, and passes them on control', () => {
    const resize = Buffer.concat([Buffer.from([251, 0, 5, 0, 3, 32, 1, 0]), Buffer.alloc(16)]);
    const input = Buffer.concat([keyEvent(true, 0x61), pointer(1, 10, 20), cutText('secret'), resize, qemuKey(true)]);

    const view = new RfbClientFilter(false);
    view.push(handshake());
    expect(view.push(Buffer.concat([input, fbUpdateRequest])).forward).toEqual([fbUpdateRequest]);
    // Split across messages, input still never passes.
    expect(feedBytewise(view, Buffer.concat([input, fbUpdateRequest])).forward).toEqual(fbUpdateRequest);

    const control = new RfbClientFilter(true);
    control.push(handshake());
    expect(Buffer.concat(control.push(input).forward)).toEqual(input);
    expect(feedBytewise(control, input).forward).toEqual(input);
  });

  it('reads ClientCutText length as int32 and takes Extended Clipboard (negative) lengths', () => {
    const filter = new RfbClientFilter(true);
    filter.push(handshake());
    const extended = cutText('\u0000\u0000\u0000\u0001zlibdata', true);
    const result = feedBytewise(filter, Buffer.concat([extended, fbUpdateRequest]));
    expect(result.close).toBeUndefined();
    expect(result.forward).toEqual(Buffer.concat([extended, fbUpdateRequest]));
  });

  it('closes on a huge clipboard, an unknown message, a bad version or another security type', () => {
    const huge = Buffer.alloc(8);
    huge[0] = 6;
    huge.writeInt32BE(MAX_CUT_TEXT_BYTES + 1, 4);
    const filter = new RfbClientFilter(true);
    filter.push(handshake());
    expect(filter.push(huge).close).toMatch(/clipboard/);
    expect(filter.push(fbUpdateRequest)).toEqual({ forward: [], close: 'closed' });

    const unknown = new RfbClientFilter(true);
    unknown.push(handshake());
    expect(unknown.push(Buffer.from([7, 0, 0, 0])).close).toMatch(/unknown message type 7/);

    expect(new RfbClientFilter(true).push(Buffer.from('RFB 004.000\n')).close).toMatch(/version/);
    const vncAuth = new RfbClientFilter(true);
    expect(vncAuth.push(Buffer.concat([VERSION, Buffer.from([2])])).close).toMatch(/security/);

    const qemu = new RfbClientFilter(true);
    qemu.push(handshake());
    expect(qemu.push(Buffer.from([255, 9])).close).toMatch(/QEMU/);
  });

  it('speaks RFB 3.3, where the client sends no security choice', () => {
    const v33 = Buffer.from('RFB 003.003\n');
    const result = feedBytewise(new RfbClientFilter(false), Buffer.concat([v33, Buffer.from([0]), fbUpdateRequest]));
    expect(result.forward).toEqual(Buffer.concat([v33, Buffer.from([1]), fbUpdateRequest]));
  });

  it('releases the keys and buttons a control session still holds', () => {
    const filter = new RfbClientFilter(true);
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
    expect(Buffer.concat(filter.releaseInput())).toEqual(
      Buffer.concat([keyEvent(false, 0xffe1), qemuKey(false), pointer(0, 100, 200)]),
    );
    expect(filter.releaseInput()).toEqual([]);
    expect(new RfbClientFilter(false).releaseInput()).toEqual([]);
  });

  describe('pseudo-encodings that change the client framing (ExtendedMouseButtons)', () => {
    const EXTENDED_MOUSE = -316;
    // What noVNC 1.7 sends (core/rfb.js _sendEncodings), quality 6 / compression 2.
    const NOVNC = [1, 7, -260, 16, 21, 5, 2, 6, 0, -26, -254, -223, -224, -258, -261, -308, -309, -312, -313, -307];
    const novncEncodings = [...NOVNC, 0xc0a1e5ce | 0, EXTENDED_MOUSE, 0x574d5664, -239];

    /** Frames forwarded client bytes the way the display does, given the encodings it was sent. */
    function displayMessages(stream: Buffer): Buffer[] {
      let extendedMouse = false;
      const out: Buffer[] = [];
      let rest = stream.subarray(12 + 1 + 1);
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

    it('strips ExtendedMouseButtons, and any pseudo-encoding it cannot frame, from SetEncodings', () => {
      const { forward, close } = feedBytewise(
        new RfbClientFilter(false),
        Buffer.concat([handshake(), setEncodings(novncEncodings)]),
      );
      expect(close).toBeUndefined();
      expect(displayMessages(forward)).toEqual([setEncodings([...NOVNC, 0xc0a1e5ce | 0, 0x574d5664, -239])]);
      expect(filterSetEncodings(setEncodings([7, -305, -257, -223]))).toEqual(setEncodings([7, -223]));
      const plain = setEncodings([7, 0, -223]);
      expect(filterSetEncodings(plain)).toBe(plain);
    });

    it('never lets a forwarded message turn into a KeyEvent on the display while the member only watches', () => {
      const out: Buffer[] = [];
      const view = new RfbClientFilter(false);
      for (const chunk of [handshake(), setEncodings(novncEncodings), pointer(0x80, 10, 20)]) {
        out.push(...view.push(chunk).forward);
      }
      // A FramebufferUpdateRequest whose bytes 1-8 spell KeyEvent(down, 'a').
      const smuggle = Buffer.from([3, 4, 1, 0, 0, 0, 0, 0, 0x61, 0]);
      out.push(...view.push(smuggle).forward);
      const sent = displayMessages(Buffer.concat(out));
      expect(sent.slice(1)).toEqual([smuggle]);
      expect(sent.some((message) => message[0] === 4)).toBe(false);
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
