import { z } from 'zod';
export const noteInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(4000).default(''),
});
export const noteSchema = noteInputSchema.extend({ id: z.string(), created_at: z.string() });
export const exampleSettingsSchema = z.object({ label: z.string().trim().min(1).max(80) });
export type ExampleNote = z.infer<typeof noteSchema>;
