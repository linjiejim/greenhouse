import { z } from 'zod';

export const OPERATION_SWITCHES = ['pause_background_runs', 'disable_computers', 'disable_outbound_mail'] as const;
export const operationSwitchesSchema = z.object({
  pause_background_runs: z.boolean(),
  disable_computers: z.boolean(),
  disable_outbound_mail: z.boolean(),
});
export const updateOperationSwitchesSchema = operationSwitchesSchema.partial().strict();
export type OperationSwitches = z.infer<typeof operationSwitchesSchema>;
export type OperationSwitch = (typeof OPERATION_SWITCHES)[number];
