import { z } from 'zod';

/** Public: what a client needs before sign-in. */
export const bootstrapSchema = z.object({
  api_version: z.number().int(),
  name: z.string(),
  primary_color: z.string().nullable(),
  /** Public by nature (the sign-in page shows it): a short-lived URL that needs no sign-in. */
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
    /** An image I uploaded with purpose `branding`; null removes the logo. The one it replaces is deleted. */
    logo_file_id: z.string().min(1).max(64).nullable(),
  })
  .partial();
export type BrandingInput = z.infer<typeof brandingInputSchema>;
