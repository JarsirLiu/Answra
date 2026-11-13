/** `/model` 模型选择器：当前模型置顶、最多 10 项、失败时保留当前模型与手动切换提示。 */
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { PanelFrame } from "../chrome/PanelFrame";
import { TUI_THEME } from "../chrome/theme";
import type { ModelPickerData } from "../panel";

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
  const visible = ordered.slice(0, VISIBLE_MODELS);
  const hidden = ordered.length - visible.length;
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
      if (busy) return;
      if (key.escape) {
        close();
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
    { isActive: !busy },
  );

  return (
    <PanelFrame
      title="Select model"
      description="选择当前会话使用的 chat 模型。"
      footer={busy ? "正在切换模型…" : "↑/↓ 选择 · Enter 切换 · Esc 取消"}
    >
      {state.kind === "loading" ? <Text dimColor>正在读取模型列表…</Text> : null}
      {shownError === undefined ? null : (
        <Box marginBottom={1}>
          <Text color={TUI_THEME.error}>{shownError}</Text>
        </Box>
      )}
      {visible.map((model, index) => {
        const focused = index === selected;
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
      {hidden > 0 ? <Text dimColor> and {hidden} more…</Text> : null}
      {state.kind === "ready" && ordered.length === 0 && shownError === undefined ? (
        <Text dimColor>未找到模型。可用 /model &lt;ID&gt; 直接切换。</Text>
      ) : null}
      {shownError === undefined ? null : (
        <Box marginTop={1}>
          <Text dimColor>可用 /model &lt;ID&gt; 直接切换，或先 /config 检查端点。</Text>
        </Box>
      )}
    </PanelFrame>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
