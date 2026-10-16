/**
 * An Agent's computer on API v2 (`/api/agents/:id/computer`): my copy of it (an Agent of mine,
 * or my own copy of a public one), its state, start / stop / restart, its background processes,
 * the files in its home, and one-time tickets for the screen.
 *
 * The screen is a WebSocket (`/api/ws/computer?ticket=`, RFB for noVNC) that cannot carry a
 * bearer header: a ticket (one minute, one socket) is minted right before each connect.
 * `view` watches — the server drops any input on it; `control` takes over.
 * Every call answers an `ApiResult` (./client.ts), never throws.
 */

import type { ComputerFolder, ComputerJob, ComputerTicket, ComputerView } from '../shared/contract';
import { del, get, post, seg } from './client';

const base = (agentId: string) => `/api/agents/${seg(agentId)}/computer`;

export const getComputer = (agentId: string) => get<ComputerView>(base(agentId));

export const startComputer = (agentId: string) => post<ComputerView>(`${base(agentId)}/start`);

export const stopComputer = (agentId: string) => post<ComputerView>(`${base(agentId)}/stop`);

/** Processes end, files in the home stay. */
export const restartComputer = (agentId: string) => post<ComputerView>(`${base(agentId)}/restart`);

export const computerProcesses = (agentId: string) => get<{ items: ComputerJob[] }>(`${base(agentId)}/processes`);

/** A one-time ticket for the screen: `view` watches, `control` takes over. Good for a minute. */
export const computerTicket = (agentId: string, purpose: 'view' | 'control') =>
  post<ComputerTicket>(`${base(agentId)}/ticket`, { purpose });

/** A folder of the home, by its path in the home ('' is the home itself). */
export const computerFiles = (agentId: string, path = '') => get<ComputerFolder>(`${base(agentId)}/files`, { path });

/** Deletes a file, or a folder with everything in it. */
export const removeComputerFile = (agentId: string, path: string) => del(`${base(agentId)}/files`, { path });

/** The path of a home file's bytes (fetched with the bearer token, then shared or previewed). */
export const computerFilePath = (agentId: string, path: string) =>
  `${base(agentId)}/files/content?path=${encodeURIComponent(path)}`;

/** `ws(s)://<station>/api/ws/computer?ticket=…` — the ticket is the credential (no bearer token in it). */
export function computerSocketUrl(apiBase: string, ticket: string): string {
  const root = apiBase.replace(/\/+$/, '').replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s.toLowerCase()}://`);
  return `${root}/api/ws/computer?ticket=${encodeURIComponent(ticket)}`;
}
