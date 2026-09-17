import type { CoworkerInbox, CoworkerTopic, CoworkerActivity } from '@greenhouse/types/session';
import { rpc } from './client';

export interface CoworkerHistory {
  inbox: CoworkerInbox;
  topics: CoworkerTopic[];
  activities: CoworkerActivity[];
  next_cursor: string | null;
}
export async function fetchCoworkerInboxes(): Promise<{ inboxes: CoworkerInbox[] }> {
  const response = await rpc.api.coworkers.$get();
  if (!response.ok) throw new Error('Unable to load coworkers');
  return response.json();
}
export async function openCoworker(profileId: string) {
  const args = { json: { profile_id: profileId } };
  const response = await rpc.api.coworkers.open.$post(args);
  if (!response.ok) throw new Error('Unable to open coworker');
  return response.json();
}
export async function visitCoworker(id: string, sessionId: string | null) {
  const args = { param: { id }, json: { session_id: sessionId } };
  const response = await rpc.api.coworkers[':id'].visit.$post(args);
  if (!response.ok) throw new Error('Unable to save topic');
  return response.json();
}
export async function fetchCoworkerTopics(id: string, cursor?: string): Promise<CoworkerHistory> {
  const args = { param: { id }, query: cursor ? { cursor } : {} };
  const response = await rpc.api.coworkers[':id'].topics.$get(args);
  if (!response.ok) throw new Error('Unable to load topics');
  return response.json();
}
export async function readCoworkerMessages(sessionId: string, ids: string[]) {
  const args = { param: { id: sessionId }, json: { message_ids: ids } };
  const response = await rpc.api.coworkers.topics[':id'].read.$post(args);
  if (!response.ok) throw new Error('Unable to save read position');
  return response.json();
}
