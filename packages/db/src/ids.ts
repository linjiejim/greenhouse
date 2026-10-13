/**
 * Ids are text: a type prefix plus a ULID (`agt_01J…`). ULIDs sort by creation time, so
 * they double as pagination cursors, and they cannot be enumerated.
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ID_PREFIX = {
  member: 'mbr',
  group: 'grp',
  share: 'shr',
  refreshToken: 'rtk',
  authLink: 'alk',
  oauthClient: 'ocl',
  oauthGrant: 'ogr',
  oauthToken: 'otk',
  agent: 'agt',
  agentVersion: 'agv',
  memory: 'mem',
  conversation: 'cnv',
  message: 'msg',
  note: 'nte',
  handoff: 'hof',
  request: 'req',
  run: 'run',
  runStep: 'stp',
  file: 'fil',
  connector: 'cnr',
  connection: 'cnx',
  notification: 'ntf',
  pushDevice: 'pdv',
  schedule: 'sch',
  budget: 'bdg',
  reservation: 'brv',
  job: 'job',
  computer: 'cmp',
  computerWatch: 'cwt',
  vaultItem: 'vlt',
  skill: 'skl',
  skillVersion: 'skv',
} as const;
export type IdKind = keyof typeof ID_PREFIX;

/** A ULID: 48-bit milliseconds then 80 random bits, Crockford base32, 26 characters. */
export function ulid(time = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isInteger(time) || time < 0 || time > 2 ** 48 - 1) throw new Error(`Invalid ULID time ${time}`);
  if (random.length !== 10) throw new Error('A ULID needs exactly 10 random bytes');
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

export function newId(kind: IdKind, time?: number): string {
  return `${ID_PREFIX[kind]}_${ulid(time)}`;
}

/** True when `id` looks like an id of this kind (prefix and ULID shape). */
export function isId(kind: IdKind, id: string): boolean {
  return new RegExp(`^${ID_PREFIX[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`).test(id);
}
