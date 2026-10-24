/**
 * Card actions a reply offers that change something (web parity): saving a captured task
 * (`POST /api/prompts`) and applying a table plan (`POST /api/tables/schema-plan/apply`). Each
 * carries the card's action id (`artifact:<message>:<step>:<tool>`); the server claims it once,
 * so a second tap — here or on the web — never runs it twice, and its receipt
 * (`GET /api/artifact-actions/:id`) restores the outcome after a reload.
 */

import type { SchemaPlan, TaskCapture } from '../chat/parts';
import { get, post, seg } from './client';

export interface ActionReceipt {
  id: string;
  status: 'processing' | 'succeeded' | 'failed';
  result: unknown;
  error: string | null;
}

export const getReceipt = (actionId: string) =>
  get<{ receipt: ActionReceipt | null }>(`/api/artifact-actions/${seg(actionId)}`);

export const saveCapturedTask = (capture: TaskCapture, actionId: string, sessionId: string) =>
  post<{ id: number }>('/api/prompts', {
    title: capture.title.trim(),
    content: capture.content.trim(),
    description: capture.description?.trim() || undefined,
    variables: capture.variables,
    expected_tools: capture.expected_tools,
    source_session_id: capture.source_session_id,
    created_via: 'capture',
    artifact_action_id: actionId,
    artifact_session_id: sessionId,
  });

export interface PlanResult {
  results: { status: 'applied' | 'failed' | 'skipped'; message?: string }[];
}

export const applySchemaPlan = (plan: SchemaPlan, actionId: string, sessionId: string) =>
  post<PlanResult>('/api/tables/schema-plan/apply', { operations: plan.operations, action_id: actionId, session_id: sessionId });
