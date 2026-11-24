/** `/skills` 浏览器：按来源分组展示名称、描述与目录；只读，不加载或执行 skill。 */
import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import type { CodingSkillSummary } from "../../session/codingSession";
import { PanelFrame } from "../chrome/PanelFrame";
import { POINTER, TUI_THEME } from "../chrome/theme";
import { padToWidth, truncateToWidth } from "../commands/paletteLayout";
import type { SkillsPanelData } from "./panel";

/** 分组顺序按覆盖优先级：工作区最高，内置最低。 */
const SKILL_GROUPS: readonly {
  readonly source: CodingSkillSummary["source"];
  readonly label: string;
}[] = [
  { source: "workspace", label: "项目 skill" },
  { source: "user", label: "用户 skill" },
  { source: "builtin", label: "内置 skill" },
];

const SOURCE_LABELS: Readonly<Record<CodingSkillSummary["source"], string>> = {
  workspace: "项目",
  user: "用户",
  builtin: "内置",
};

/** `PanelFrame` 内容区左右各 padding 2 列。 */
const PANEL_CONTENT_PADDING_COLUMNS = 4;
const POINTER_COLUMNS = 2;
const MIN_VISIBLE_ROWS = 4;
/** 标题、来源分组、详情与 footer 的固定开销；给可见列表留出不会撑出视口的高度。 */
const RESERVED_ROWS = 17;
/** 详情只摘要两行，完整正文由 transcript 的 Skill 卡片展开查看。 */
const DETAIL_DESCRIPTION_LINES = 2;
const NAME_COLUMN_RATIO = 0.35;
const MIN_NAME_COLUMNS = 12;
const MAX_NAME_COLUMNS = 28;

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: SkillsPanelData }
  | { readonly kind: "error"; readonly message: string };

type Row =
  | { readonly kind: "group"; readonly label: string; readonly count: number }
  | { readonly kind: "skill"; readonly skill: CodingSkillSummary };

export function SkillsPanel({ load, close }: { load(): Promise<SkillsPanelData>; close(): void }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (alive) setState({ kind: "ready", data });
      })
      .catch((cause: unknown) => {
        if (alive) setState({ kind: "error", message: messageOf(cause) });
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const { columns, rows: terminalRows } = useWindowSize();
  const skills = state.kind === "ready" ? state.data.skills : [];
  const { ordered, rows } = buildRows(skills);
  const focused = ordered[Math.min(selected, Math.max(0, ordered.length - 1))];
  const selectedRow = rows.findIndex((row) => row.kind === "skill" && row.skill === focused);
  const visibleRowCount = Math.max(MIN_VISIBLE_ROWS, terminalRows - RESERVED_ROWS);
  const maxStart = Math.max(0, rows.length - visibleRowCount);
  const windowStart = Math.min(
    Math.max(0, (selectedRow === -1 ? 0 : selectedRow) - visibleRowCount + 1),
    maxStart,
  );
  const visibleRows = rows.slice(windowStart, windowStart + visibleRowCount);
  const above = windowStart;
  const below = rows.length - windowStart - visibleRows.length;

  const contentColumns = Math.max(20, columns - PANEL_CONTENT_PADDING_COLUMNS - POINTER_COLUMNS);
  const nameColumns = Math.min(
    MAX_NAME_COLUMNS,
    Math.max(MIN_NAME_COLUMNS, Math.floor(contentColumns * NAME_COLUMN_RATIO)),
  );
  const descriptionColumns = Math.max(1, contentColumns - nameColumns);

  const move = (next: number): void => {
    if (ordered.length === 0) return;
    setSelected(Math.max(0, Math.min(ordered.length - 1, next)));
  };

  useInput((_input, key) => {
    if (key.escape) {
      close();
      return;
    }
    if (key.upArrow) {
      move(selected - 1);
      return;
    }
    if (key.downArrow) {
      move(selected + 1);
      return;
    }
    if (key.pageUp) {
      move(selected - visibleRowCount);
      return;
    }
    if (key.pageDown) {
      move(selected + visibleRowCount);
    }
  });

  return (
    <PanelFrame
      title="Skills"
      description="当前会话可用的 skill；按来源分组，同名 skill 由工作区覆盖用户与内置。"
      footer={ordered.length === 0 ? "Esc 关闭" : "↑/↓ 选择 · PgUp/PgDn 翻页 · Esc 关闭"}
    >
      <Box flexDirection="column">
        {state.kind === "loading" ? <Text dimColor>正在读取 skill 目录…</Text> : null}
        {shownError(state) === undefined ? null : (
          <Box marginBottom={1}>
            <Text color={TUI_THEME.error}>{shownError(state)}</Text>
          </Box>
        )}
        {state.kind === "ready" && skills.length === 0 && shownError(state) === undefined ? (
          <Box flexDirection="column">
            <Text dimColor>没有发现可用 skill。</Text>
            <Text dimColor>
              检查工作区 .agents/skills、用户 skill 目录或内置 skill 是否有 SKILL.md。
            </Text>
          </Box>
        ) : null}
        {above > 0 ? <Text dimColor> ↑ {above} more…</Text> : null}
        {visibleRows.map((row) =>
          row.kind === "group" ? (
            <Box key={`group-${row.label}`}>
              <Text bold dimColor>
                {`${row.label}（${row.count}）`}
              </Text>
            </Box>
          ) : (
            <SkillRow
              key={`${row.skill.source}-${row.skill.name}`}
              descriptionColumns={descriptionColumns}
              focused={row.skill === focused}
              nameColumns={nameColumns}
              skill={row.skill}
            />
          ),
        )}
        {below > 0 ? <Text dimColor> ↓ {below} more…</Text> : null}
        {focused === undefined ? null : (
          <SkillDetail contentColumns={contentColumns} skill={focused} />
        )}
      </Box>
    </PanelFrame>
  );
}

function SkillRow({
  skill,
  focused,
  nameColumns,
  descriptionColumns,
}: {
  skill: CodingSkillSummary;
  focused: boolean;
  nameColumns: number;
  descriptionColumns: number;
}) {
  const color = focused ? TUI_THEME.suggestion : TUI_THEME.text;
  const name = padToWidth(truncateToWidth(skill.name, nameColumns - 1), nameColumns);
  const description = truncateToWidth(oneLine(skill.description), descriptionColumns);
  return (
    <Box>
      <Text color={color}>{`${focused ? POINTER : " "} `}</Text>
      <Text bold={focused} color={color} wrap="truncate">
        {name}
      </Text>
      <Text color={focused ? color : undefined} dimColor={!focused} wrap="truncate">
        {description}
      </Text>
    </Box>
  );
}

function SkillDetail({
  skill,
  contentColumns,
}: {
  skill: CodingSkillSummary;
  contentColumns: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={TUI_THEME.suggestion} wrap="truncate">
        {truncateToWidth(`${skill.name} · ${SOURCE_LABELS[skill.source]}`, contentColumns)}
      </Text>
      <Text wrap="wrap">
        {truncateToWidth(oneLine(skill.description), contentColumns * DETAIL_DESCRIPTION_LINES)}
      </Text>
      <Text dimColor wrap="truncate">
        {truncateToWidth(skill.directory, contentColumns)}
      </Text>
    </Box>
  );
}

function buildRows(skills: readonly CodingSkillSummary[]): {
  ordered: readonly CodingSkillSummary[];
  rows: readonly Row[];
} {
  const ordered: CodingSkillSummary[] = [];
  const rows: Row[] = [];
  for (const group of SKILL_GROUPS) {
    const grouped = skills.filter((skill) => skill.source === group.source);
    if (grouped.length === 0) continue;
    rows.push({ kind: "group", label: group.label, count: grouped.length });
    for (const skill of grouped) {
      rows.push({ kind: "skill", skill });
      ordered.push(skill);
    }
  }
  return { ordered, rows };
}

function shownError(state: LoadState): string | undefined {
  if (state.kind === "error") return state.message;
  if (state.kind === "ready") return state.data.error;
  return undefined;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
