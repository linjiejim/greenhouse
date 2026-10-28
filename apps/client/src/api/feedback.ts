/** Feedback from 「我」 → 发送反馈 (`POST /api/me/feedback`); a 404 means the Feedback plugin is off. */
import { post } from './client';

export const sendFeedback = (message: string, context: Record<string, string>) =>
  post<{ id: string }>('/api/me/feedback', { message, context });
