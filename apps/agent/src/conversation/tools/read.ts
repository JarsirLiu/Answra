/** Read retrieves bounded, line-numbered plain text from the active workspace. */

import { jsonSchema, tool } from "ai";
import type { ConversationToolContext } from "./types";
import {
  assertNotAborted,
  readWorkspaceText,
  requireWorkspaceRoot,
  truncateToolOutput,
} from "./workspace";

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export const readDefinition = {
  id: "conversation.read",
  name: "Read",
  description:
    "读取工作区内的纯文本文件。file_path 使用相对工作区根目录的路径；可用 offset 和 limit 读取指定行范围。",
  inputSchema: jsonSchema<ReadInput>({
    type: "object",
    properties: {
      file_path: { type: "string", minLength: 1, maxLength: 1024 },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 2000 },
    },
    required: ["file_path"],
    additionalProperties: false,
  }),
  create(context: ConversationToolContext) {
    return tool({
      description: this.description,
      inputSchema: this.inputSchema,
      execute: (input) => executeRead(context, input),
    });
  },
} as const;

export async function executeRead(
  context: ConversationToolContext,
  { file_path, offset = 1, limit = 2000 }: ReadInput,
): Promise<string> {
  assertNotAborted(context.signal);
  const root = requireWorkspaceRoot(context.workspaceRoot);
  const text = await readWorkspaceText(root, file_path);
  assertNotAborted(context.signal);
  const lines = text.split(/\r?\n/);
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = selected.map((line, index) => `${offset + index}\t${line}`).join("\n");
  return truncateToolOutput(numbered || "[文件为空或所选范围无内容]");
}
