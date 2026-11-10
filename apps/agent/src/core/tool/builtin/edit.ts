/** Edit：在已读文件中精确替换一段文本，校验并发修改并以原子写回填会话状态。 */
import type { EditDiffDisplay } from "@answra/shared/schema";
import type { JSONSchema7 } from "ai";
import { defineTool, type ToolContext, type ToolHandlerFailure, toolId } from "../contracts";
import { ToolExecutionError } from "../executor/result";
import { buildEditDisplayDiff } from "./editDisplayDiff";
import { replaceEditText } from "./editMatch";
import {
  clearReadFileStatesForPath,
  findReadFileStateForEdit,
  matchesFileStat,
  recordEditedFileState,
} from "./readFileState";
import {
  assertNotAborted,
  EDIT_FILE_MAX_BYTES,
  readToolTextFileForEdit,
  resolveToolWriteFile,
  type ToolLineEndings,
  writeToolTextFileAtomic,
} from "./workspace";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditOutput {
  readonly type: "edited";
  readonly filePath: string;
  readonly replacements: number;
  readonly replaceAll: boolean;
  readonly lineEndings: ToolLineEndings;
  readonly sizeBytes: number;
  /** 只供 UI 展示的多 hunk diff；不会进入模型可见内容。 */
  readonly diff: EditDiffDisplay;
}

const EDIT_MAX_OUTPUT_BYTES = 20_000;

const EDIT_TOOL_DESCRIPTION = [
  "Edits an existing text file by replacing exact text.",
  "",
  "- Read the file first; editing is rejected without a complete read of the current content.",
  "- `old_string` must match the file exactly and uniquely unless `replace_all` is true.",
  "- Line-number prefixes copied from Read results are tolerated.",
  "- `new_string` may be empty to delete the matched text.",
  "- Do not re-read the file just to verify the edit; the result confirms the write.",
].join("\n");

const EDIT_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    file_path: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description:
        "The file to edit. Absolute paths are preferred; workspace-relative paths are also accepted.",
    },
    old_string: {
      type: "string",
      minLength: 1,
      maxLength: EDIT_FILE_MAX_BYTES,
      description: "The exact text to replace.",
    },
    new_string: {
      type: "string",
      maxLength: EDIT_FILE_MAX_BYTES,
      description: "The replacement text; an empty string deletes the matched text.",
    },
    replace_all: {
      type: "boolean",
      description: "Replace every match instead of requiring a unique match.",
    },
  },
  required: ["file_path", "old_string", "new_string"],
  additionalProperties: false,
};

export const editTool = defineTool<EditInput, EditOutput>({
  id: toolId("workspace.edit"),
  metadata: {
    name: "Edit",
    description: EDIT_TOOL_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    sideEffectScope: "workspace",
    timeoutMs: 30_000,
    maxOutputBytes: EDIT_MAX_OUTPUT_BYTES,
    resultBudget: { strategy: "truncate", maxModelChars: EDIT_MAX_OUTPUT_BYTES },
  },
  inputSchema: EDIT_INPUT_SCHEMA,
  exposeOutput: true,
  handler: (input, context) => executeEdit(context, input),
  validateInput: validateEditInput,
  formatModelContent: formatEditOutput,
});

export async function executeEdit(context: ToolContext, input: EditInput): Promise<EditOutput> {
  const state = context.readFileState;
  if (!state) {
    throw new ToolExecutionError("invalid-input", "当前会话没有文件读取状态，不能编辑文件");
  }

  assertNotAborted(context.signal);
  const target = await resolveToolWriteFile(context.workspaceRoot, input.file_path);
  const baseline = findReadFileStateForEdit(state, target);
  if (!baseline) {
    throw new ToolExecutionError(
      "invalid-input",
      "编辑前必须先用 Read 完整读取该文件；没有可用的读取记录",
    );
  }

  const file = await readToolTextFileForEdit(target, EDIT_FILE_MAX_BYTES);
  assertNotAborted(context.signal);
  if (!matchesFileStat(baseline, file)) {
    throw new ToolExecutionError("invalid-input", "文件在读取后已被修改，请重新 Read 后再编辑");
  }

  const replaceAll = input.replace_all ?? false;
  const match = replaceEditText({
    text: file.text,
    oldString: input.old_string,
    newString: input.new_string,
    replaceAll,
  });
  if (match.type === "failed") {
    if (match.reason === "ambiguous") {
      throw new ToolExecutionError(
        "invalid-input",
        `旧内容在文件中出现了 ${match.matches} 次，无法确定替换位置；请提供更多上下文，或设置 replace_all=true`,
      );
    }
    throw new ToolExecutionError(
      "invalid-input",
      "旧内容未在文件中找到；请重新 Read 后使用文件中的原文",
    );
  }

  if (match.text === file.text.replaceAll("\r\n", "\n")) {
    throw new ToolExecutionError("invalid-input", "替换后内容与原文相同，不需要写盘");
  }

  const diff = buildEditDisplayDiff(file.text, match.text);
  assertNotAborted(context.signal);
  const written = await writeToolTextFileAtomic(target, match.text, {
    bom: file.bom,
    encoding: file.encoding,
    expectedMtimeMs: file.mtimeMs,
    expectedSizeBytes: file.sizeBytes,
    lineEndings: file.lineEndings,
    maxBytes: EDIT_FILE_MAX_BYTES,
    mode: file.mode,
  });

  clearReadFileStatesForPath(state, target);
  recordEditedFileState(state, {
    mtimeMs: written.mtimeMs,
    path: target,
    sizeBytes: written.sizeBytes,
  });

  return {
    type: "edited",
    filePath: target,
    replacements: match.replacements,
    replaceAll,
    lineEndings: file.lineEndings,
    sizeBytes: written.sizeBytes,
    diff,
  };
}

export function formatEditOutput(output: EditOutput): string {
  const occurrenceLabel = output.replacements === 1 ? "occurrence" : "occurrences";
  const allLabel = output.replaceAll ? " All matches were replaced." : "";
  return `The file ${output.filePath} has been updated successfully. Replaced ${output.replacements} ${occurrenceLabel}.${allLabel} No need to read it again to verify.`;
}

function validateEditInput(input: unknown): ToolHandlerFailure | undefined {
  if (typeof input !== "object" || input === null) {
    return invalidInput("编辑参数必须是对象");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.file_path !== "string" || value.file_path.length === 0) {
    return invalidInput("file_path 必须是非空字符串");
  }
  if (typeof value.old_string !== "string" || value.old_string.length === 0) {
    return invalidInput("old_string 必须是非空字符串；新建文件请使用后续 Write 工具");
  }
  if (typeof value.new_string !== "string") {
    return invalidInput("new_string 必须是字符串");
  }
  if (value.old_string === value.new_string) {
    return invalidInput("old_string 与 new_string 相同，不需要写盘");
  }
  if (value.replace_all !== undefined && typeof value.replace_all !== "boolean") {
    return invalidInput("replace_all 必须是布尔值");
  }
  return undefined;
}

function invalidInput(message: string): ToolHandlerFailure {
  return { ok: false, code: "invalid-input", message };
}
