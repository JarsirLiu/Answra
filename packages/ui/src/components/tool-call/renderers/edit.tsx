import { editDiffDisplaySchema } from "@answra/shared/schema";
import { Check, Copy, Pencil } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ToolCallCard } from "../ToolCallCard";
import { ToolDetailSection, ToolErrorBlock, ToolNotice, ToolOutputBlock } from "../ToolCallDetails";
import type { ToolCallRendererProps } from "../toolCallPart";
import {
  asRecord,
  clipText,
  fileName,
  formatToolValue,
  isToolCallError,
  isToolCallRunning,
  MAX_TOOL_VALUE_CHARS,
  numberField,
  stringField,
} from "../toolCallPresentation";
import styles from "./edit.module.css";
import { buildEditDiff } from "./editDiff";
import { type EditDiffView, fromEditDiffDisplay, fromLegacyEditDiff } from "./editDisplay";

const TOOL_FAILURE_PREFIX = "工具调用失败（";
const REPLACEMENTS_PATTERN = /Replaced (\d+) occurrences?/;

/** Edit: file name in the summary; a code diff of the attempted replacement when expanded. */
export function EditToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const filePath = input ? stringField(input, "file_path") : undefined;
  const oldString = input ? stringField(input, "old_string") : undefined;
  const newString = input ? stringField(input, "new_string") : undefined;
  const replaceAll = input?.replace_all === true;
  const structured = asRecord(part.output);
  const outputText = typeof part.output === "string" ? part.output : undefined;
  const outputType = structured ? stringField(structured, "type") : undefined;
  const receiptMatch = outputText?.match(REPLACEMENTS_PATTERN);
  const replacements =
    structured && outputType === "edited"
      ? numberField(structured, "replacements")
      : receiptMatch
        ? Number(receiptMatch[1])
        : undefined;
  const businessError =
    outputText?.startsWith(TOOL_FAILURE_PREFIX) === true ? outputText : undefined;
  const rawError = part.errorText ?? businessError;
  const error = rawError ? clipText(rawError, MAX_TOOL_VALUE_CHARS) : undefined;
  const malformed =
    part.output !== undefined && outputText === undefined && outputType !== "edited"
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const structuredDiff = useMemo(() => {
    const diff = structured?.diff;
    return diff === undefined ? undefined : editDiffDisplaySchema.safeParse(diff);
  }, [structured]);
  const diff = useMemo(() => {
    if (structuredDiff?.success) return fromEditDiffDisplay(structuredDiff.data);
    if (oldString !== undefined && newString !== undefined) {
      return fromLegacyEditDiff(buildEditDiff(oldString, newString));
    }
    return undefined;
  }, [structuredDiff, oldString, newString]);
  const hasDetails = error !== undefined || diff !== undefined || malformed !== undefined;
  const notWritten =
    error !== undefined || isToolCallError(part.state) || part.state === "interrupted";
  const waiting = diff !== undefined && isToolCallRunning(part.state);
  const created = diff !== undefined && oldString === "";
  const displayName = filePath ? fileName(filePath) : (part.title ?? "文件");
  const summaryCounts = diff ? (
    <>
      <span className={styles.additions}>+{diff.additions}</span>{" "}
      <span className={styles.deletions}>-{diff.deletions}</span>
    </>
  ) : undefined;

  return (
    <ToolCallCard
      actionLabel={created ? "Created" : "Edited"}
      expandedPrimary={diff ? "file" : undefined}
      icon={<Pencil size={13} />}
      part={part}
      primary={
        <span className={styles.summaryFile} title={filePath}>
          {displayName}
        </span>
      }
      summaryExtra={summaryCounts}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {notWritten ? <ToolNotice>编辑未写入文件。</ToolNotice> : null}
          {waiting ? <ToolNotice>等待写入完成。</ToolNotice> : null}
          {diff ? (
            <EditDiffCard
              diff={diff}
              filePath={filePath ?? part.title ?? "文件"}
              replacements={replacements}
              replaceAll={replaceAll}
              copyText={newString ?? ""}
            />
          ) : null}
          {malformed ? (
            <ToolDetailSection label="结果">
              <ToolOutputBlock text={malformed.text} />
            </ToolDetailSection>
          ) : null}
        </>
      ) : undefined}
    </ToolCallCard>
  );
}

function EditDiffCard({
  diff,
  filePath,
  replacements,
  replaceAll,
  copyText,
}: {
  diff: EditDiffView;
  filePath: string;
  replacements?: number;
  replaceAll: boolean;
  copyText: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 900);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
    } catch {
      /* 剪贴板不可用时仍展示已复制状态，与代码块保持一致。 */
    }
    setCopied(true);
  };

  return (
    <section aria-label="编辑差异" className={styles.diffPanel}>
      <div className={styles.diffHeader}>
        <span className={styles.fileName} title={filePath}>
          {fileName(filePath)}
        </span>
        {replaceAll && replacements !== undefined && replacements > 1 ? (
          <span className={styles.replacements}>{replacements} 处替换</span>
        ) : null}
        <span className={styles.additions}>+{diff.additions}</span>
        <span className={styles.deletions}>-{diff.deletions}</span>
        <button
          aria-label={copied ? "已复制修改后片段" : "复制修改后片段"}
          className={styles.copyButton}
          onClick={copy}
          title={copied ? "已复制修改后片段" : "复制修改后片段"}
          type="button"
        >
          {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
        </button>
      </div>
      <div className={styles.diffBody}>
        <div className={styles.diffTable}>
          {diff.hunks.map((hunk, hunkIndex) => {
            const previous = diff.hunks[hunkIndex - 1];
            const gap = previous ? hunk.oldStart - (previous.oldStart + previous.oldLines) : 0;
            return (
              <Fragment key={`${hunk.oldStart}-${hunk.newStart}-${hunk.oldLines}-${hunk.newLines}`}>
                {gap > 0 ? (
                  <div className={styles.diffGap}>
                    <span aria-hidden="true" className={styles.diffGapMarker}>
                      ⋯
                    </span>
                    <span>{gap} 行未修改</span>
                  </div>
                ) : null}
                {hunk.lines.map((line) => (
                  <div
                    className={styles.diffRow}
                    data-kind={line.kind}
                    key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
                  >
                    <span className={styles.lineNumber}>{line.newLine ?? line.oldLine ?? ""}</span>
                    <span className={styles.lineText}>{line.text}</span>
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>
      {diff.truncated ? <ToolNotice>差异过大，仅显示部分内容。</ToolNotice> : null}
    </section>
  );
}
