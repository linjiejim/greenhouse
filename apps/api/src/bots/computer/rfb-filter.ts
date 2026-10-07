/**
 * Client → server RFB filter for the live viewer (spec §6.4, review R24).
 *
 * "View only" must be enforced by the server: noVNC's viewOnly flag is a
 * browser setting the member (or a script in their page) can flip. So the
 * viewer proxy parses the client's byte stream — which arrives in arbitrary
 * WebSocket chunks — into whole RFB messages and only forwards input while
 * the member holds the take-over lease:
 *
 *   12-byte ProtocolVersion → 1-byte security choice (3.7/3.8; None only) →
 *   1-byte ClientInit (rewritten to shared=1, so a viewer can never kick the
 *   other viewers) → framed messages.
 *
 * Messages: 0 SetPixelFormat, 2 SetEncodings, 3 FramebufferUpdateRequest,
 * 4 KeyEvent, 5 PointerEvent, 6 ClientCutText (int32 length; negative =
 * Extended Clipboard, take the absolute value), 150 EnableContinuousUpdates,
 * 248 ClientFence, 250 xvp, 251 SetDesktopSize, 255 QEMU (extended key event,
 * audio). Input — 4, 5, 6, 251, 255 — is dropped unless input is allowed; an
 * unknown type closes the connection (its length is unknowable, so the stream
 * can't be resynchronised safely).
 *
 * The filter and Xvnc must always agree on where each message ends, or the
 * bytes of a forwarded non-input message could be read by Xvnc as a KeyEvent
 * while the member only watches. Pseudo-encodings in SetEncodings can change
 * the CLIENT's framing — ExtendedMouseButtons (-316) makes a PointerEvent 7
 * bytes whenever its marker bit is set — so SetEncodings is rewritten on the
 * way through: only pseudo-encodings whose client→server framing this filter
 * parses, or that only shape what the server sends, reach Xvnc. Everything
 * else, -316 included, is removed; the server never switches it on and noVNC
 * stays on the plain 6-byte PointerEvent (Back/Forward buttons do nothing).
 *
 * When input stops being allowed mid-press, `releaseInput()` returns the
 * key-up / button-up messages for what was forwarded, so no key stays stuck
 * down on the shared desktop when the Bots take over again.
 */

/** Clipboard text larger than this is refused (it would only ever be a paste bomb). */
export const MAX_CUT_TEXT_BYTES = 1024 * 1024;

export interface RfbFilterResult {
  /** Whole messages (or handshake bytes) to write to the server, in order. */
  forward: Buffer[];
  /** Set when the stream must be closed; nothing after it is forwarded. */
  close?: string;
}

type Phase = 'version' | 'security' | 'init' | 'messages' | 'closed';

const INPUT_TYPES = new Set([4, 5, 6, 251, 255]);
const SECURITY_NONE = 1;

/**
 * Pseudo-encodings forwarded to the server (see the file header). Real
 * encodings (≥ 0, which includes the VMware cursor) only shape server→client
 * rectangles and always pass.
 */
const FORWARDED_PSEUDO_ENCODINGS = new Set([
  -223, // DesktopSize
  -224, // LastRect
  -232, // PointerPos
  -239, // Cursor
  -240, // XCursor
  -258, // QEMU Extended Key Event → message 255/0, framed above
  -259, // QEMU Audio → message 255/1, framed above
  -260, // TightPNG (an encoding in the pseudo range)
  -261, // QEMU LED state (server → client only)
  -307, // DesktopName
  -308, // ExtendedDesktopSize → SetDesktopSize (251), framed above
  -309, // xvp → message 250, framed above
  -312, // Fence → ClientFence (248), framed above
  -313, // ContinuousUpdates → EnableContinuousUpdates (150), framed above
  -314, // Cursor with alpha
  0xc0a1e5ce | 0, // Extended Clipboard → negative ClientCutText length, framed above
]);

function forwardsEncoding(encoding: number): boolean {
  if (encoding >= 0) return true;
  if (encoding >= -32 && encoding <= -23) return true; // JPEG quality level
  if (encoding >= -256 && encoding <= -247) return true; // compression level
  return FORWARDED_PSEUDO_ENCODINGS.has(encoding);
}

/** SetEncodings without the pseudo-encodings Xvnc must never switch on (unchanged when there are none). */
export function filterSetEncodings(message: Buffer): Buffer {
  const count = message.readUInt16BE(2);
  const kept: number[] = [];
  for (let i = 0; i < count; i++) {
    const encoding = message.readInt32BE(4 + 4 * i);
    if (forwardsEncoding(encoding)) kept.push(encoding);
  }
  if (kept.length === count) return message;
  const out = Buffer.alloc(4 + 4 * kept.length);
  out[0] = 2;
  out.writeUInt16BE(kept.length, 2);
  kept.forEach((encoding, i) => out.writeInt32BE(encoding, 4 + 4 * i));
  return out;
}

/** Length of the message at the head of `buf`; null = need more bytes; string = protocol error. */
export function rfbMessageLength(buf: Buffer): number | null | string {
  if (buf.length < 1) return null;
  const type = buf[0]!;
  switch (type) {
    case 0:
      return 20;
    case 2:
      return buf.length < 4 ? null : 4 + 4 * buf.readUInt16BE(2);
    case 3:
      return 10;
    case 4:
      return 8;
    case 5:
      // Always 6: ExtendedMouseButtons, the one extension that lengthens it,
      // never reaches the server (filterSetEncodings).
      return 6;
    case 6: {
      if (buf.length < 8) return null;
      const length = Math.abs(buf.readInt32BE(4));
      return length > MAX_CUT_TEXT_BYTES ? 'clipboard too large' : 8 + length;
    }
    case 150:
      return 10;
    case 248: {
      if (buf.length < 9) return null;
      const payload = buf[8]!;
      return payload > 64 ? 'fence payload too large' : 9 + payload;
    }
    case 250:
      return 4;
    case 251:
      return buf.length < 8 ? null : 8 + 16 * buf[6]!;
    case 255: {
      if (buf.length < 2) return null;
      const subtype = buf[1]!;
      if (subtype === 0) return 12; // extended key event
      if (subtype === 1) {
        if (buf.length < 4) return null;
        const operation = buf.readUInt16BE(2);
        if (operation === 0 || operation === 1) return 4; // audio enable / disable
        if (operation === 2) return 10; // audio set format
        return `unknown QEMU audio operation ${operation}`;
      }
      return `unknown QEMU message ${subtype}`;
    }
    default:
      return `unknown message type ${type}`;
  }
}

export class RfbClientFilter {
  private phase: Phase = 'version';
  private buffer = Buffer.alloc(0);
  private readonly keys = new Set<number>();
  /** QEMU extended keys: keysym → keycode. */
  private readonly qemuKeys = new Map<number, number>();
  private buttons = 0;
  private pointerX = 0;
  private pointerY = 0;

  constructor(private readonly inputAllowed: () => boolean) {}

  push(chunk: Uint8Array): RfbFilterResult {
    if (this.phase === 'closed') return { forward: [], close: 'closed' };
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const forward: Buffer[] = [];
    const fail = (reason: string): RfbFilterResult => {
      this.phase = 'closed';
      this.buffer = Buffer.alloc(0);
      return { forward, close: reason };
    };

    for (;;) {
      if (this.phase === 'version') {
        if (this.buffer.length < 12) break;
        const version = this.buffer.subarray(0, 12);
        const match = /^RFB 003\.00([378])\n$/.exec(version.toString('latin1'));
        if (!match) return fail('unsupported protocol version');
        forward.push(Buffer.from(version));
        this.buffer = this.buffer.subarray(12);
        // RFB 3.3: the server picks the security type; the client sends no choice.
        this.phase = match[1] === '3' ? 'init' : 'security';
        continue;
      }
      if (this.phase === 'security') {
        if (this.buffer.length < 1) break;
        if (this.buffer[0] !== SECURITY_NONE) return fail('unsupported security type');
        forward.push(Buffer.from([SECURITY_NONE]));
        this.buffer = this.buffer.subarray(1);
        this.phase = 'init';
        continue;
      }
      if (this.phase === 'init') {
        if (this.buffer.length < 1) break;
        forward.push(Buffer.from([1])); // ClientInit: shared
        this.buffer = this.buffer.subarray(1);
        this.phase = 'messages';
        continue;
      }
      const length = rfbMessageLength(this.buffer);
      if (typeof length === 'string') return fail(length);
      if (length === null || this.buffer.length < length) break;
      let message: Buffer = Buffer.from(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
      const type = message[0]!;
      if (type === 2) message = filterSetEncodings(message);
      if (INPUT_TYPES.has(type)) {
        if (!this.inputAllowed()) continue;
        this.track(message);
      }
      forward.push(message);
    }
    return { forward };
  }

  /** Messages that release every key and button forwarded so far (see the file header). */
  releaseInput(): Buffer[] {
    if (this.phase !== 'messages') return [];
    const out: Buffer[] = [];
    for (const keysym of this.keys) {
      const message = Buffer.alloc(8);
      message[0] = 4;
      message.writeUInt32BE(keysym, 4);
      out.push(message);
    }
    for (const [keysym, keycode] of this.qemuKeys) {
      const message = Buffer.alloc(12);
      message[0] = 255;
      message.writeUInt32BE(keysym, 4);
      message.writeUInt32BE(keycode, 8);
      out.push(message);
    }
    if (this.buttons !== 0) {
      const message = Buffer.alloc(6);
      message[0] = 5;
      message.writeUInt16BE(this.pointerX, 2);
      message.writeUInt16BE(this.pointerY, 4);
      out.push(message);
    }
    this.keys.clear();
    this.qemuKeys.clear();
    this.buttons = 0;
    return out;
  }

  private track(message: Buffer): void {
    const type = message[0]!;
    if (type === 4) {
      const keysym = message.readUInt32BE(4);
      if (message[1]) this.keys.add(keysym);
      else this.keys.delete(keysym);
    } else if (type === 5) {
      this.buttons = message[1]!;
      this.pointerX = message.readUInt16BE(2);
      this.pointerY = message.readUInt16BE(4);
    } else if (type === 255 && message[1] === 0) {
      const keysym = message.readUInt32BE(4);
      if (message.readUInt16BE(2)) this.qemuKeys.set(keysym, message.readUInt32BE(8));
      else this.qemuKeys.delete(keysym);
    }
  }
}
