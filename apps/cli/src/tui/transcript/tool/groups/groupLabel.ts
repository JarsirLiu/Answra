/** Tense-aware labels for folded read/search/list rows. */
import { isToolRunning, type ToolPresentation } from "@answra/ui/tool-presentation";

const GROUP_ORDER = ["search", "read", "list"] as const;

type GroupCategory = (typeof GROUP_ORDER)[number];

export interface ToolGroupLabel {
  readonly label: string;
  readonly currentTarget?: string;
}

const VERBS: Readonly<Record<GroupCategory, { readonly active: string; readonly past: string }>> = {
  search: { active: "Searching", past: "Searched" },
  read: { active: "Reading", past: "Read" },
  list: { active: "Listing", past: "Listed" },
};

export function groupLabel(
  presentations: readonly ToolPresentation[],
  running: boolean,
): ToolGroupLabel {
  const counts = new Map<GroupCategory, number>();
  const targets = new Map<GroupCategory, Set<string>>();
  for (const presentation of presentations) {
    const category = groupCategory(presentation.category);
    if (category === undefined) continue;
    const target = targetKey(presentation);
    const seen = targets.get(category) ?? new Set<string>();
    if (!seen.has(target)) {
      seen.add(target);
      targets.set(category, seen);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  const pieces: string[] = [];
  for (const category of GROUP_ORDER) {
    const count = counts.get(category) ?? 0;
    if (count === 0) continue;
    const verb = running ? VERBS[category].active : VERBS[category].past;
    const piece = `${verb} ${count} ${noun(category, count)}`;
    pieces.push(pieces.length === 0 ? piece : lowercaseFirst(piece));
  }

  const current = running ? currentTarget(presentations) : undefined;
  return {
    label: pieces.length > 0 ? pieces.join(", ") : `${presentations.length} tool calls`,
    ...(current === undefined ? {} : { currentTarget: current }),
  };
}

function groupCategory(category: ToolPresentation["category"]): GroupCategory | undefined {
  return category === "search" || category === "read" || category === "list" ? category : undefined;
}

function targetKey(presentation: ToolPresentation): string {
  if (presentation.category === "read" && presentation.secondary !== undefined) {
    return `${presentation.secondary}/${presentation.primary}`;
  }
  return presentation.primary;
}

function currentTarget(presentations: readonly ToolPresentation[]): string | undefined {
  for (let index = presentations.length - 1; index >= 0; index -= 1) {
    const presentation = presentations[index];
    if (presentation === undefined) continue;
    if (groupCategory(presentation.category) !== undefined && isToolRunning(presentation.state)) {
      return targetKey(presentation);
    }
  }
  for (let index = presentations.length - 1; index >= 0; index -= 1) {
    const presentation = presentations[index];
    if (presentation === undefined) continue;
    if (groupCategory(presentation.category) !== undefined) return targetKey(presentation);
  }
  return undefined;
}

function noun(category: GroupCategory, count: number): string {
  if (category === "search") return count === 1 ? "pattern" : "patterns";
  if (category === "read") return count === 1 ? "file" : "files";
  return count === 1 ? "directory" : "directories";
}

function lowercaseFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;
}
