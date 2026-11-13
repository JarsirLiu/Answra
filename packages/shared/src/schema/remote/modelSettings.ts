import { z } from "zod";

/** 远程可传输的模型设置只包含非 secret 字段；API key 永远留在 host。 */
export const remoteModelSourceSchema = z.enum(["local", "cloud"]);

export const remoteLocalModelInputSchema = z.strictObject({
  baseUrl: z.string(),
  chatModel: z.string(),
  answerModel: z.string().optional(),
});

export const remoteModelSettingsViewSchema = z.strictObject({
  source: remoteModelSourceSchema,
  baseUrl: z.string(),
  chatModel: z.string(),
  answerModel: z.string().optional(),
  configured: z.boolean(),
});

export const remoteModelEndpointSchema = z.strictObject({
  baseUrl: z.string(),
  model: z.string(),
  auth: z.enum(["cloud", "local"]).optional(),
});

export const remoteModelConfigSchema = z.strictObject({
  chat: remoteModelEndpointSchema,
  answer: remoteModelEndpointSchema,
});

export type RemoteModelSource = z.infer<typeof remoteModelSourceSchema>;
export type RemoteLocalModelInput = z.infer<typeof remoteLocalModelInputSchema>;
export type RemoteModelSettingsView = z.infer<typeof remoteModelSettingsViewSchema>;
export type RemoteModelConfig = z.infer<typeof remoteModelConfigSchema>;
