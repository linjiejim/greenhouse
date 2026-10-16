/**
 * fetch for endpoints a member typed in. The address was checked when it was saved; this
 * checks it again at connect time, so a DNS answer that later points inside the network
 * (rebinding) still cannot reach a private address.
 */

import { lookup, type LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { isPrivateAddress } from './network.js';

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function publicLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) {
  lookup(hostname, { family: options.family ?? 0, all: true }, (error, addresses) => {
    if (error) return callback(error, options.all ? [] : '');
    const allowed = addresses.filter((entry) => !isPrivateAddress(entry.address));
    if (!allowed.length) {
      const blocked: NodeJS.ErrnoException = new Error(`${hostname} resolves only to private addresses.`);
      blocked.code = 'EPRIVATEADDRESS';
      return callback(blocked, options.all ? [] : '');
    }
    if (options.all) return callback(null, allowed);
    return callback(null, allowed[0]!.address, allowed[0]!.family);
  });
}

const agent = new Agent({ connect: { lookup: publicLookup as never } });

export const publicFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
