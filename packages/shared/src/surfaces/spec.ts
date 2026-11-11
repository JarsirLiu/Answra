import { z } from "zod";

/**
 * 浮窗内容的声明式契约：产品代码与后续 Agent 只能提交这份 schema 描述的
 * JSON，渲染器只认固定原语，不执行外部 HTML、CSS 或脚本。
 */

export const SURFACE_LIMITS = {
  maxNodes: 64,
  maxDepth: 6,
  maxTextLength: 2000,
  maxActions: 6,
  maxSpecBytes: 64 * 1024,
} as const;

export type SurfaceTextVariant = "title" | "body" | "caption";
export type SurfaceButtonVariant = "primary" | "secondary" | "danger";

export interface SurfaceStackNode {
  type: "stack";
  direction: "row" | "column";
  gap?: number;
  children: SurfaceNode[];
}

export interface SurfaceTextNode {
  type: "text";
  text: string;
  variant?: SurfaceTextVariant;
}

export interface SurfaceButtonNode {
  type: "button";
  label: string;
  actionId: string;
  variant?: SurfaceButtonVariant;
  disabled?: boolean;
}

export interface SurfaceListNode {
  type: "list";
  items: { text: string; checked?: boolean }[];
}

export interface SurfaceProgressNode {
  type: "progress";
  value: number;
  label?: string;
}

export interface SurfaceDividerNode {
  type: "divider";
}

export type SurfaceNode =
  | SurfaceStackNode
  | SurfaceTextNode
  | SurfaceButtonNode
  | SurfaceListNode
  | SurfaceProgressNode
  | SurfaceDividerNode;

export type SurfacePanel = "chat" | "interview" | "notes" | "settings";

export type SurfaceAction =
  | { type: "dismiss" }
  | { type: "open-panel"; panel: SurfacePanel }
  | { type: "send-message"; text: string }
  | { type: "invoke"; command: string };

const surfaceNodeSchema: z.ZodType<SurfaceNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("stack"),
      direction: z.enum(["row", "column"]),
      gap: z.number().int().min(0).max(24).optional(),
      children: z.array(surfaceNodeSchema).max(24),
    }),
    z.strictObject({
      type: z.literal("text"),
      text: z.string().max(SURFACE_LIMITS.maxTextLength),
      variant: z.enum(["title", "body", "caption"]).optional(),
    }),
    z.strictObject({
      type: z.literal("button"),
      label: z.string().min(1).max(40),
      actionId: z.string().min(1).max(40),
      variant: z.enum(["primary", "secondary", "danger"]).optional(),
      disabled: z.boolean().optional(),
    }),
    z.strictObject({
      type: z.literal("list"),
      items: z
        .array(
          z.strictObject({
            text: z.string().min(1).max(200),
            checked: z.boolean().optional(),
          }),
        )
        .max(12),
    }),
    z.strictObject({
      type: z.literal("progress"),
      value: z.number().min(0).max(1),
      label: z.string().max(80).optional(),
    }),
    z.strictObject({ type: z.literal("divider") }),
  ]),
);

const surfaceActionSchema: z.ZodType<SurfaceAction> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("dismiss") }),
  z.strictObject({
    type: z.literal("open-panel"),
    panel: z.enum(["chat", "interview", "notes", "settings"]),
  }),
  z.strictObject({ type: z.literal("send-message"), text: z.string().min(1).max(4000) }),
  z.strictObject({ type: z.literal("invoke"), command: z.string().min(1).max(64) }),
]);

export const surfaceSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(64),
  revision: z.number().int().nonnegative(),
  producer: z.enum(["product", "agent", "user"]),
  presetId: z.string().min(1).max(64).optional(),
  title: z.string().max(80).optional(),
  root: surfaceNodeSchema,
  window: z
    .strictObject({
      width: z.number().int().min(220).max(560).optional(),
      draggable: z.boolean().optional(),
      dismissible: z.boolean().optional(),
      anchor: z.enum(["bar", "pointer", "center"]).optional(),
    })
    .optional(),
  lifecycle: z
    .strictObject({
      kind: z.enum(["ephemeral", "pinned"]),
      ttlMs: z.number().int().min(0).max(600_000).optional(),
    })
    .optional(),
  actions: z.record(z.string().min(1).max(40), surfaceActionSchema).optional(),
});

export type SurfaceSpec = z.infer<typeof surfaceSpecSchema>;

export type SurfaceSpecValidation =
  | { ok: true; spec: SurfaceSpec }
  | { ok: false; issues: readonly string[] };

/** 校验 schema 与跨字段约束；主进程和 Agent 都在各自边界调用。 */
export function parseSurfaceSpec(input: unknown): SurfaceSpecValidation {
  const result = surfaceSpecSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map(
        (issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`,
      ),
    };
  }
  const issues = collectSpecIssues(result.data);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec: result.data };
}

function collectSpecIssues(spec: SurfaceSpec): string[] {
  const issues: string[] = [];
  let nodeCount = 0;
  let maxDepth = 0;
  let textLength = 0;

  const walk = (node: SurfaceNode, depth: number): void => {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);

    switch (node.type) {
      case "stack":
        for (const child of node.children) walk(child, depth + 1);
        break;
      case "text":
        textLength += node.text.length;
        break;
      case "button":
        textLength += node.label.length;
        if (!spec.actions || !(node.actionId in spec.actions)) {
          issues.push(`button.${node.actionId}: action is not declared in actions`);
        }
        break;
      case "list": {
        const seen = new Set<string>();
        for (const item of node.items) {
          textLength += item.text.length;
          if (seen.has(item.text)) {
            issues.push(`list: duplicate item text "${item.text}"`);
          }
          seen.add(item.text);
        }
        break;
      }
      case "progress":
        textLength += node.label?.length ?? 0;
        break;
      case "divider":
        break;
    }
  };

  walk(spec.root, 1);

  if (nodeCount > SURFACE_LIMITS.maxNodes) {
    issues.push(`spec: node count ${nodeCount} exceeds ${SURFACE_LIMITS.maxNodes}`);
  }
  if (maxDepth > SURFACE_LIMITS.maxDepth) {
    issues.push(`spec: depth ${maxDepth} exceeds ${SURFACE_LIMITS.maxDepth}`);
  }
  if (textLength > SURFACE_LIMITS.maxTextLength) {
    issues.push(`spec: text length ${textLength} exceeds ${SURFACE_LIMITS.maxTextLength}`);
  }
  const actionCount = Object.keys(spec.actions ?? {}).length;
  if (actionCount > SURFACE_LIMITS.maxActions) {
    issues.push(`spec: action count ${actionCount} exceeds ${SURFACE_LIMITS.maxActions}`);
  }

  return issues;
}
