/** Edit：在已读文件中精确替换文本，或用空 old_string 创建新文件。 */
import type { EditDiffDisplay } from "@answra/shared/schema";
import type { JSONSchema7 } from "ai";
import { defineTool, type ToolContext, type ToolHandlerFailure, toolId } from "../../contracts";
import { assertNotAborted } from "../../executor/abort";
import { ToolExecutionError } from "../../executor/result";
import { EDIT_TOOL_NAME } from "../../names";
import {
  clearReadFileStatesForPath,
  findReadFileStateForEdit,
  hashReadFileContent,
  matchesFileStat,
  recordEditedFileState,
} from "../../state/readFileState";
import type { ToolLineEndings } from "../../text/lineEndings";
import {
  createToolTextFileAtomic,
  EDIT_FILE_MAX_BYTES,
  readToolTextFileForEdit,
  resolveToolWriteTarget,
  writeToolTextFileAtomic,
} from "../../workspace";
import { buildEditDisplayDiff } from "./diff";
import { replaceEditText } from "./match";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditOutput {
  readonly type: "edited" | "created";
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
  "Edits an existing text file by replacing exact text, or creates a new file.",
  "",
  "- To edit, Read the file first; editing is rejected without a complete read of the current content.",
  "- `old_string` must match the file exactly and uniquely unless `replace_all` is true.",
  "- To create a new file, set `old_string` to an empty string; `file_path` must not exist.",
  "- Line-number prefixes copied from Read results are tolerated.",
  "- `new_string` may be empty to delete the matched text, or to create an empty file.",
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
      maxLength: EDIT_FILE_MAX_BYTES,
      description:
        "The exact text to replace. Use an empty string to create a new file at a non-existent file_path.",
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
    name: EDIT_TOOL_NAME,
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
  assertNotAborted(context.signal);
  const target = await resolveToolWriteTarget(context.workspaceRoot, input.file_path);
  const creating = input.old_string === "";

  if (creating) {
    if (target.exists) return fillExistingEmptyFile(context, target.target, input.new_string);
    const written = await createToolTextFileAtomic(target.target, input.new_string, {
      maxBytes: EDIT_FILE_MAX_BYTES,
    });
    recordWrite(context, target.target, written, hashReadFileContent(input.new_string));
    return {
      type: "created",
      filePath: target.target,
      replacements: 0,
      replaceAll: false,
      lineEndings: "LF",
      sizeBytes: written.sizeBytes,
      diff: buildEditDisplayDiff("", input.new_string),
    };
  }

  if (!target.exists) {
    throw new ToolExecutionError(
      "invalid-input",
      "文件不存在；新建文件请将 old_string 设为空字符串",
    );
  }

  const state = context.readFileState;
  if (!state) {
    throw new ToolExecutionError("invalid-input", "当前会话没有文件读取状态，不能编辑文件");
  }
  const baseline = findReadFileStateForEdit(state, target.target);
  if (!baseline) {
    throw new ToolExecutionError(
      "invalid-input",
      "编辑前必须先用 Read 完整读取该文件；没有可用的读取记录",
    );
  }

  const file = await readToolTextFileForEdit(target.target, EDIT_FILE_MAX_BYTES);
  assertNotAborted(context.signal);
  if (!matchesFileStat(baseline, file, hashReadFileContent(file.text))) {
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
  const written = await writeToolTextFileAtomic(target.target, match.text, {
    bom: file.bom,
    encoding: file.encoding,
    expectedMtimeMs: file.mtimeMs,
    expectedSizeBytes: file.sizeBytes,
    lineEndings: file.lineEndings,
    maxBytes: EDIT_FILE_MAX_BYTES,
    mode: file.mode,
  });
  recordWrite(context, target.target, written, hashReadFileContent(match.text));

  return {
    type: "edited",
    filePath: target.target,
    replacements: match.replacements,
    replaceAll,
    lineEndings: file.lineEndings,
    sizeBytes: written.sizeBytes,
    diff,
  };
}

async function fillExistingEmptyFile(
  context: ToolContext,
  filePath: string,
  newString: string,
): Promise<EditOutput> {
  const file = await readToolTextFileForEdit(filePath, EDIT_FILE_MAX_BYTES);
  assertNotAborted(context.signal);
  if (file.text.length !== 0) {
    throw new ToolExecutionError(
      "invalid-input",
      "文件已存在，不能用空 old_string 覆盖；请提供要替换的原文",
    );
  }

  const state = context.readFileState;
  if (!state) {
    throw new ToolExecutionError("invalid-input", "当前会话没有文件读取状态，不能编辑文件");
  }
  const baseline = findReadFileStateForEdit(state, filePath);
  if (!baseline) {
    throw new ToolExecutionError(
      "invalid-input",
      "编辑前必须先用 Read 完整读取该文件；没有可用的读取记录",
    );
  }
  if (!matchesFileStat(baseline, file, hashReadFileContent(file.text))) {
    throw new ToolExecutionError("invalid-input", "文件在读取后已被修改，请重新 Read 后再编辑");
  }

  const written = await writeToolTextFileAtomic(filePath, newString, {
    bom: file.bom,
    encoding: file.encoding,
    expectedMtimeMs: file.mtimeMs,
    expectedSizeBytes: file.sizeBytes,
    lineEndings: file.lineEndings,
    maxBytes: EDIT_FILE_MAX_BYTES,
    mode: file.mode,
  });
  recordWrite(context, filePath, written, hashReadFileContent(newString));

  return {
    type: "created",
    filePath,
    replacements: 0,
    replaceAll: false,
    lineEndings: file.lineEndings,
    sizeBytes: written.sizeBytes,
    diff: buildEditDisplayDiff("", newString),
  };
}

export function formatEditOutput(output: EditOutput): string {
  if (output.type === "created") {
    return `The file ${output.filePath} has been created successfully. No need to read it again to verify.`;
  }
  const occurrenceLabel = output.replacements === 1 ? "occurrence" : "occurrences";
  const allLabel = output.replaceAll ? " All matches were replaced." : "";
  return `The file ${output.filePath} has been updated successfully. Replaced ${output.replacements} ${occurrenceLabel}.${allLabel} No need to read it again to verify.`;
}

function recordWrite(
  context: ToolContext,
  path: string,
  written: { readonly mtimeMs: number; readonly sizeBytes: number },
  contentHash?: string,
): void {
  const state = context.readFileState;
  if (!state) return;
  clearReadFileStatesForPath(state, path);
  recordEditedFileState(state, {
    ...(contentHash !== undefined && { contentHash }),
    mtimeMs: written.mtimeMs,
    path,
    sizeBytes: written.sizeBytes,
  });
}

function validateEditInput(input: unknown): ToolHandlerFailure | undefined {
  if (typeof input !== "object" || input === null) {
    return invalidInput("编辑参数必须是对象");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.file_path !== "string" || value.file_path.length === 0) {
    return invalidInput("file_path 必须是非空字符串");
  }
  if (typeof value.old_string !== "string") {
    return invalidInput("old_string 必须是字符串；新建文件请使用空字符串");
  }
  if (typeof value.new_string !== "string") {
    return invalidInput("new_string 必须是字符串");
  }
  if (value.replace_all !== undefined && typeof value.replace_all !== "boolean") {
    return invalidInput("replace_all 必须是布尔值");
  }
  if (value.old_string === "") {
    return value.replace_all === true ? invalidInput("新建文件不支持 replace_all") : undefined;
  }
  if (value.old_string === value.new_string) {
    return invalidInput("old_string 与 new_string 相同，不需要写盘");
  }
  return undefined;
}

function invalidInput(message: string): ToolHandlerFailure {
  return { ok: false, code: "invalid-input", message };
}
