/**
 * Ids are text: a type prefix plus a ULID (`doc_01J…`). ULIDs sort by creation
 * time and cannot be enumerated.
 *
 * Rows carried over from a 1.x database keep their original ids — serial
 * integers become their decimal string — so links, extension tables that store
 * a user id and ids an external agent remembered keep resolving. Never parse an
 * id's shape to decide anything; it is an opaque key.
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ID_PREFIX = {
  user: 'usr',
  refreshToken: 'rtk',
  passwordLink: 'pwl',
  role: 'rol',
  rolePolicy: 'rep',
  oauthClient: 'ocl',
  oauthGrant: 'ogr',
  oauthToken: 'otk',
  gatewayKey: 'gwk',
  providerConnection: 'pcn',
  conversation: 'cnv',
  message: 'msg',
  conversationShare: 'csh',
  conversationShareRead: 'csr',
  cardReceipt: 'crc',
  run: 'run',
  runStep: 'stp',
  toolCall: 'tcl',
  interrupt: 'itr',
  runEvent: 'evt',
  outbox: 'obx',
  automation: 'atm',
  runProfile: 'rpf',
  document: 'doc',
  documentVersion: 'dcv',
  share: 'shr',
  folder: 'fld',
  file: 'fil',
  project: 'prj',
  projectMember: 'pmb',
  task: 'tsk',
  taskComment: 'tcm',
  base: 'bas',
  baseTable: 'tbl',
  field: 'col',
  view: 'viw',
  record: 'rec',
  recordLink: 'rln',
  schemaVersion: 'scv',
  recomputeJob: 'rcj',
  notification: 'ntf',
  delivery: 'dlv',
  pushDevice: 'pdv',
  usageEvent: 'use',
  budget: 'bdg',
  reservation: 'brv',
  ledgerEntry: 'bld',
  price: 'prc',
  auditEvent: 'aud',
  requestLog: 'req',
  feedback: 'fbk',
  emailAccount: 'eml',
  feishuConversation: 'fsc',
  computer: 'cmp',
  reportTemplate: 'rpt',
  skill: 'skl',
  skillVersion: 'skv',
  prompt: 'prm',
  memory: 'mem',
} as const;
export type IdKind = keyof typeof ID_PREFIX;

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

/** Increment an 80-bit big-endian number in place; false on overflow. */
function increment(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index--) {
    if (bytes[index]! < 255) {
      bytes[index]! += 1;
      return true;
    }
    bytes[index] = 0;
  }
  return false;
}

function encode(time: number, random: Uint8Array): string {
  let out = '';
  let t = time;
  for (let index = 0; index < 10; index++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  let bits = 0;
  let value = 0;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/**
 * A ULID: 48-bit milliseconds then 80 random bits, Crockford base32, 26
 * characters. Monotonic within one process: two ids minted in the same
 * millisecond still sort in creation order (append-only tables page by id).
 */
export function ulid(time = Date.now()): string {
  if (!Number.isInteger(time) || time < 0 || time > 2 ** 48 - 1) throw new Error(`Invalid ULID time ${time}`);
  if (time === lastTime && increment(lastRandom)) return encode(time, lastRandom);
  lastTime = time;
  lastRandom = new Uint8Array(randomBytes(10));
  return encode(time, lastRandom);
}

export function newId(kind: IdKind, time?: number): string {
  return `${ID_PREFIX[kind]}_${ulid(time)}`;
}

/** True when `id` was minted by `newId(kind)` (prefix and ULID shape). */
export function isNewId(kind: IdKind, id: string): boolean {
  return new RegExp(`^${ID_PREFIX[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`).test(id);
}
