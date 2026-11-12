import { z } from "zod";

/** Read-only Bot identity for catalog listing and new-conversation selection. */
export const botSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  responsibility: z.string(),
  owns: z.array(z.string()),
});

export type BotSummary = z.infer<typeof botSummarySchema>;
