/** `/config` 内的模型子选择器：复刻 Claude Code ModelPicker 的列表、当前项与手动回退。 */
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { POINTER, TUI_THEME } from "../chrome/theme";
import type { ModelPickerData } from "../panel";

const VISIBLE_MODELS = 10;
const MANUAL_MODEL = "\u0000manual";

type Option = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly manual?: boolean;
};

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: ModelPickerData }
  | { readonly kind: "error"; readonly message: string };

export function ConfigModelMenu({
  answer,
  current,
  load,
  selected,
  onCancel,
  onManual,
  onSelect,
}: {
  answer: boolean;
  current: string;
  load(): Promise<ModelPickerData>;
  selected: string;
  onCancel(): void;
  onManual(): void;
  onSelect(model: string): void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [index, setIndex] = useState(0);

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

  const loadError =
    state.kind === "error" ? state.message : state.kind === "ready" ? state.data.error : undefined;
  const models = state.kind === "ready" ? state.data.models : [];
  const options = buildOptions({
    answer,
    current,
    models,
    selected,
    showManual: state.kind !== "loading" && (loadError !== undefined || models.length === 0),
  });
  const visible = options.slice(0, VISIBLE_MODELS);
  const hidden = options.length - visible.length;
  const selectedIndex = options.length === 0 ? 0 : Math.min(index, options.length - 1);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (options.length === 0) return;
    if (key.upArrow) {
      setIndex((value) => (value - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setIndex((value) => (value + 1) % options.length);
      return;
    }
    if (!key.return) return;
    const option = options[selectedIndex];
    if (option === undefined) return;
    if (option.manual === true) onManual();
    else onSelect(option.value);
  });

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={TUI_THEME.suggestion}>
          Select model
        </Text>
        <Text dimColor>
          {answer ? "选择 Answer 模型；留空表示与 Chat 相同。" : "选择当前会话使用的 chat 模型。"}
        </Text>
      </Box>
      {state.kind === "loading" ? <Text dimColor>正在读取模型列表…</Text> : null}
      {loadError === undefined ? null : (
        <Box marginBottom={1}>
          <Text color={TUI_THEME.error}>{loadError}</Text>
        </Box>
      )}
      {visible.map((option, optionIndex) => {
        const focused = optionIndex === selectedIndex;
        return (
          <Box key={option.value === MANUAL_MODEL ? "manual" : option.value}>
            <Text color={focused ? TUI_THEME.suggestion : TUI_THEME.text}>
              {focused ? POINTER : " "}
            </Text>
            <Text color={option.selected ? TUI_THEME.success : TUI_THEME.inactive}>
              {" "}
              {option.selected ? "✓" : " "}
            </Text>
            <Text bold={focused} color={focused ? TUI_THEME.suggestion : TUI_THEME.text}>
              {" "}
              {option.label}
            </Text>
            {option.description === undefined ? null : <Text dimColor> {option.description}</Text>}
          </Box>
        );
      })}
      {hidden > 0 ? <Text dimColor> and {hidden} more…</Text> : null}
    </Box>
  );
}

function buildOptions({
  answer,
  current,
  models,
  selected,
  showManual,
}: {
  answer: boolean;
  current: string;
  models: readonly string[];
  selected: string;
  showManual: boolean;
}): readonly Option[] {
  const options: Option[] = [];
  if (answer) {
    options.push({
      value: "",
      label: "与 Chat 相同",
      description: "使用 Chat 模型",
      selected: selected === "",
    });
  }
  const ids = [...new Set([current, selected, ...models].filter((model) => model !== ""))];
  for (const model of ids) {
    options.push({
      value: model,
      label: model,
      ...(model === current ? { description: answer ? "Chat 模型" : "Current model" } : {}),
      selected: model === selected,
    });
  }
  if (showManual) {
    options.push({
      value: MANUAL_MODEL,
      label: "手动输入模型 ID…",
      description: "模型目录不可用时使用",
      selected: false,
      manual: true,
    });
  }
  return options;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
