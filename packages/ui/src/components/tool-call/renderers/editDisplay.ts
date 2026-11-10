/** 把 shared 的多 hunk 展示契约投影成 Edit 卡片的行号视图；不做文件读取或 diff 计算。 */
import type { EditDiffDisplay, EditDiffHunk } from "@answra/shared/schema";
import type { EditDiff, EditDiffLine } from "./editDiff";

export interface EditHunkView {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly EditDiffLine[];
}

export interface EditDiffView {
  readonly hunks: readonly EditHunkView[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

export function fromEditDiffDisplay(display: EditDiffDisplay): EditDiffView {
  return {
    hunks: display.hunks.map(toHunkView),
    additions: display.additions,
    deletions: display.deletions,
    truncated: display.truncated,
  };
}

export function fromLegacyEditDiff(diff: EditDiff): EditDiffView {
  if (diff.lines.length === 0) {
    return {
      hunks: [],
      additions: diff.additions,
      deletions: diff.deletions,
      truncated: diff.truncated,
    };
  }

  const oldStart = diff.lines.find((line) => line.oldLine !== undefined)?.oldLine ?? 1;
  const newStart = diff.lines.find((line) => line.newLine !== undefined)?.newLine ?? 1;
  return {
    hunks: [
      {
        oldStart,
        newStart,
        oldLines: diff.lines.filter((line) => line.kind !== "added").length,
        newLines: diff.lines.filter((line) => line.kind !== "removed").length,
        lines: diff.lines,
      },
    ],
    additions: diff.additions,
    deletions: diff.deletions,
    truncated: diff.truncated,
  };
}

function toHunkView(hunk: EditDiffHunk): EditHunkView {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const lines = hunk.lines.map((line) => {
    if (line.kind === "context") {
      const view = { kind: line.kind, oldLine, newLine, text: line.text } as const;
      oldLine += 1;
      newLine += 1;
      return view;
    }
    if (line.kind === "removed") {
      const view = { kind: line.kind, oldLine, text: line.text } as const;
      oldLine += 1;
      return view;
    }
    const view = { kind: line.kind, newLine, text: line.text } as const;
    newLine += 1;
    return view;
  });

  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines,
  };
}
