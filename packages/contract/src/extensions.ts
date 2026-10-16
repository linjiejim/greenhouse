import { z } from 'zod';
export const extensionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  pages: z.array(z.string()),
  settings_sections: z.array(z.string()),
  admin_sections: z.array(z.string()),
  entity_panels: z.array(z.object({ id: z.string(), entity: z.string() })),
});
export type ExtensionInfo = z.infer<typeof extensionInfoSchema>;
