/** `/model` 模型选择器：当前模型置顶、可视窗口随选中项滚动、失败时保留当前模型与手动切换提示。 */
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { PanelFrame } from "../chrome/PanelFrame";
import { TUI_THEME } from "../chrome/theme";
import { PromptInput } from "../composer/PromptInput";
import type { ModelPickerData } from "./panel";

const VISIBLE_MODELS = 10;

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: ModelPickerData }
  | { readonly kind: "error"; readonly message: string };

export function ModelPicker({
  load,
  select,
  close,
}: {
  load(): Promise<ModelPickerData>;
  select(model: string): Promise<void>;
  close(): void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState(false);

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

  const current = state.kind === "ready" ? state.data.current : "";
  const models = state.kind === "ready" ? state.data.models : [];
  const ordered =
    current === "" ? models : [current, ...models.filter((model) => model !== current)];
  const maxStart = Math.max(0, ordered.length - VISIBLE_MODELS);
  const windowStart = Math.min(Math.max(0, selected - VISIBLE_MODELS + 1), maxStart);
  const visible = ordered.slice(windowStart, windowStart + VISIBLE_MODELS);
  const above = windowStart;
  const below = ordered.length - windowStart - visible.length;
  const loadError =
    state.kind === "error" ? state.message : state.kind === "ready" ? state.data.error : undefined;
  const shownError = error ?? loadError;

  const choose = async (model: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await select(model);
      setBusy(false);
      close();
    } catch (cause) {
      setBusy(false);
      setError(messageOf(cause));
    }
  };

  useInput(
    (_input, key) => {
      if (busy || manual) return;
      if (key.escape) {
        close();
        return;
      }
      if (key.tab) {
        setManual(true);
        return;
      }
      if (ordered.length === 0) return;
      if (key.upArrow) {
        setSelected((index) => (index - 1 + ordered.length) % ordered.length);
        return;
      }
      if (key.downArrow) {
        setSelected((index) => (index + 1) % ordered.length);
        return;
      }
      if (!key.return) return;
      const model = ordered[selected];
      if (model !== undefined) void choose(model);
    },
    { isActive: !busy && !manual },
  );

  return (
    <PanelFrame
      title="Select model"
      description={
        manual
          ? "输入模型 ID；模型目录不是唯一来源，可直接覆盖当前模型名。"
          : "选择当前会话使用的 chat 模型；按 Tab 输入自定义模型 ID。"
      }
      footer={
        manual
          ? "Enter 切换 · Esc 返回列表"
          : busy
            ? "正在切换模型…"
            : "↑/↓ 选择 · Enter 切换 · Tab 手动输入 · Esc 取消"
      }
    >
      {manual ? (
        <Box flexDirection="column">
          <Text dimColor>当前模型：{current === "" ? "未设置" : current}</Text>
          <Box marginTop={1}>
            <PromptInput
              active
              allowEmptySubmit={false}
              busy={busy}
              commandsEnabled={false}
              exitOnCtrlC={false}
              historyEnabled={false}
              initialValue={current}
              marginTop={0}
              maxVisibleLines={1}
              onEscape={() => setManual(false)}
              onSubmit={(value) => {
                setManual(false);
                void choose(value);
              }}
              showBorder={false}
              showHints={false}
              showPointer={false}
            />
          </Box>
        </Box>
      ) : (
        <>
          {state.kind === "loading" ? <Text dimColor>正在读取模型列表…</Text> : null}
          {shownError === undefined ? null : (
            <Box marginBottom={1}>
              <Text color={TUI_THEME.error}>{shownError}</Text>
            </Box>
          )}
          {above > 0 ? <Text dimColor> ↑ {above} more…</Text> : null}
          {visible.map((model, index) => {
            const focused = windowStart + index === selected;
            const isCurrent = model === current;
            return (
              <Box key={model}>
                <Text color={focused ? TUI_THEME.suggestion : TUI_THEME.text}>
                  {focused ? "❯" : " "}
                </Text>
                <Text color={isCurrent ? TUI_THEME.success : TUI_THEME.inactive}>
                  {" "}
                  {isCurrent ? "✓" : " "}
                </Text>
                <Text bold={focused} color={focused ? TUI_THEME.suggestion : TUI_THEME.text}>
                  {" "}
                  {model}
                </Text>
                {isCurrent ? <Text dimColor> Current model</Text> : null}
              </Box>
            );
          })}
          {below > 0 ? <Text dimColor> ↓ {below} more…</Text> : null}
          {state.kind === "ready" && ordered.length === 0 && shownError === undefined ? (
            <Text dimColor>未找到模型。按 Tab 输入模型 ID，或使用 /model &lt;ID&gt;。</Text>
          ) : null}
          {shownError === undefined ? null : (
            <Box marginTop={1}>
              <Text dimColor>按 Tab 输入模型 ID，或先 /config 检查端点。</Text>
            </Box>
          )}
        </>
      )}
    </PanelFrame>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
