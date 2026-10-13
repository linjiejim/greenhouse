import { z } from 'zod';

/** Public: what a client needs before sign-in. */
export const bootstrapSchema = z.object({
  api_version: z.number().int(),
  name: z.string(),
  primary_color: z.string().nullable(),
  logo_url: z.string().nullable(),
  login_methods: z.array(z.enum(['password', 'feishu'])),
  setup_pending: z.boolean(),
});
export type Bootstrap = z.infer<typeof bootstrapSchema>;

export const brandingInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    primary_color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable(),
  })
  .partial();
export type BrandingInput = z.infer<typeof brandingInputSchema>;
