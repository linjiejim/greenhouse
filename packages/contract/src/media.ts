import { z } from 'zod';
import { KNOWLEDGE_SPACES } from './knowledge.js';

export const saveMediaInputSchema = z
  .object({
    space: z.enum(KNOWLEDGE_SPACES).default('personal'),
    folder_id: z.string().min(1).max(100).optional(),
  })
  .strict();
export type SaveMediaInput = z.input<typeof saveMediaInputSchema>;
