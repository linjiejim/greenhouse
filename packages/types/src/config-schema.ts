/**
 * Validation for `greenhouse.config.ts` (server side). Kept apart from `./config`
 * so clients that only need the types never pull zod into their bundle.
 */
import { z } from 'zod';
import { mergeGreenhouseConfig, type GreenhouseConfig, type GreenhouseConfigInput } from './config.js';

const StationSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'station ids are lowercase letters, digits and dashes'),
  name: z.string().min(1),
  url: z.string().url(),
});

const ClientStationsSchema = z
  .object({
    mode: z.enum(['multi', 'single']).optional(),
    defaults: z.array(StationSchema).optional(),
  })
  .refine((v) => v.mode !== 'single' || (v.defaults?.length ?? 0) === 1, {
    message: "clients.stations.mode 'single' needs exactly one entry in clients.stations.defaults",
    path: ['defaults'],
  });

export const GreenhouseConfigInputSchema = z.object({
  extensions: z
    .object({
      enabled: z.union([z.literal('all'), z.array(z.string().min(1))]).optional(),
    })
    .optional(),
  packs: z
    .object({
      skills: z.array(z.string().min(1)).optional(),
      profiles: z.array(z.string().min(1)).optional(),
      seeds: z.string().min(1).optional(),
    })
    .optional(),
  clients: z.object({ stations: ClientStationsSchema.optional() }).optional(),
});

/** Validate a config file's export and fill in defaults. Throws a readable error on bad input. */
export function parseGreenhouseConfig(input: unknown): GreenhouseConfig {
  const result = GreenhouseConfigInputSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new Error(`Invalid greenhouse.config.ts:\n${z.prettifyError(result.error)}`);
  }
  return mergeGreenhouseConfig(result.data as GreenhouseConfigInput);
}
