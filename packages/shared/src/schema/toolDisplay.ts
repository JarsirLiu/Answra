import { z } from "zod";

/** Edit 展开卡的展示 diff；只供 UI 消费，不是模型可见的工具结果。 */
export const editDiffLineKindSchema = z.enum(["context", "removed", "added"]);
export const editDiffLineSchema = z.strictObject({
  kind: editDiffLineKindSchema,
  text: z.string(),
});
export const editDiffHunkSchema = z.strictObject({
  /** 包含上下文的第一条旧文件行号，1-based。 */
  oldStart: z.number().int().positive(),
  oldLines: z.number().int().nonnegative(),
  /** 包含上下文的第一条新文件行号，1-based。 */
  newStart: z.number().int().positive(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(editDiffLineSchema).min(1),
});
export const editDiffDisplaySchema = z.strictObject({
  hunks: z.array(editDiffHunkSchema).min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type EditDiffLineKind = z.infer<typeof editDiffLineKindSchema>;
export type EditDiffLine = z.infer<typeof editDiffLineSchema>;
export type EditDiffHunk = z.infer<typeof editDiffHunkSchema>;
export type EditDiffDisplay = z.infer<typeof editDiffDisplaySchema>;
