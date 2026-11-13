/** `/config` 面板：可搜索设置列表、行内编辑与模型子选择器；只编排 TUI 状态，I/O 由宿主端口注入。 */
import { Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { PanelFrame } from "../chrome/PanelFrame";
import { TUI_THEME } from "../chrome/theme";
import type { ModelPickerData } from "../panel";
import { ConfigList } from "./ConfigList";
import { ConfigModelMenu } from "./ConfigModelMenu";
import {
  type ConfigField,
  type ConfigFormValues,
  type ConfigPanelData,
  type ConfigSaveInput,
  configFormFromData,
  configSaveInput,
  validateConfigForm,
} from "./configForm";
import { configPanelFooter, filterConfigRows } from "./configPresentation";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: ConfigPanelData; readonly values: ConfigFormValues }
  | { readonly kind: "error"; readonly message: string };

export function ConfigPanel({
  load,
  loadModels,
  save,
  close,
}: {
  load(): Promise<ConfigPanelData>;
  loadModels(): Promise<ModelPickerData>;
  save(input: ConfigSaveInput): Promise<void>;
  close(reason?: "saved" | "dismissed"): void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [searchMode, setSearchMode] = useState(true);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<ConfigField>();
  const [submenu, setSubmenu] = useState<ConfigField>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revealApiKey, setRevealApiKey] = useState(false);

  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (!alive) return;
        setState({ kind: "ready", data, values: configFormFromData(data) });
      })
      .catch((cause: unknown) => {
        if (alive) setState({ kind: "error", message: messageOf(cause) });
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const rows = filterConfigRows(query);
  const selectedRow = rows[Math.min(index, Math.max(0, rows.length - 1))];

  useEffect(() => {
    if (selectedRow?.field !== "apiKey") setRevealApiKey(false);
  }, [selectedRow?.field]);

  const updateValue = (field: ConfigField, value: string): void => {
    setState((current) =>
      current.kind === "ready"
        ? { ...current, values: { ...current.values, [field]: value } }
        : current,
    );
  };

  const persist = async (values: ConfigFormValues): Promise<void> => {
    if (state.kind !== "ready") return;
    const invalid = validateConfigForm(values);
    if (invalid !== undefined) {
      setError(invalid);
      setSearchMode(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await save(configSaveInput(values, state.data.apiKey));
      setBusy(false);
      close("saved");
    } catch (cause) {
      setBusy(false);
      setError(messageOf(cause));
    }
  };

  const openField = (field: ConfigField): void => {
    setError(undefined);
    setRevealApiKey(false);
    if (field === "chatModel" || field === "answerModel") {
      setSubmenu(field);
      return;
    }
    setEditing(field);
  };

  useInput(
    (input, key) => {
      if (busy) return;
      if (state.kind !== "ready") {
        if (key.escape) close("dismissed");
        return;
      }
      if (editing !== undefined || submenu !== undefined) return;
      if (searchMode) {
        if (key.escape) {
          if (query === "") setSearchMode(false);
          else {
            setQuery("");
            setIndex(0);
          }
          return;
        }
        if (key.return || key.downArrow) {
          if (rows.length > 0) {
            setSearchMode(false);
            setIndex(0);
          }
          return;
        }
        if (key.upArrow) return;
        if (key.backspace || key.delete) {
          if (query !== "") {
            setQuery(query.slice(0, -1));
            setIndex(0);
          }
          return;
        }
        if (key.ctrl || key.meta || key.tab) return;
        if (input.length > 0) {
          setQuery(query + input);
          setIndex(0);
        }
        return;
      }
      if (key.escape) {
        close("dismissed");
        return;
      }
      if (key.upArrow) {
        if (rows.length > 0) setIndex((index - 1 + rows.length) % rows.length);
        return;
      }
      if (key.downArrow) {
        if (rows.length > 0) setIndex((index + 1) % rows.length);
        return;
      }
      if (input === "/") {
        setSearchMode(true);
        setQuery("");
        setIndex(0);
        return;
      }
      if (key.ctrl && input === "r" && selectedRow?.field === "apiKey") {
        setRevealApiKey((value) => !value);
        return;
      }
      if (key.ctrl && input === "s") {
        void persist(state.values);
        return;
      }
      if ((key.return || key.rightArrow) && selectedRow !== undefined) {
        openField(selectedRow.field);
      }
    },
    { isActive: editing === undefined && submenu === undefined && !busy },
  );

  const footer = configPanelFooter({
    busy,
    loaded: state.kind === "ready",
    submenu: submenu !== undefined,
    editing,
    searching: searchMode,
    selectedField: selectedRow?.field,
  });

  return (
    <PanelFrame title="模型配置" footer={footer}>
      {state.kind === "loading" ? <Text dimColor>正在读取模型配置…</Text> : null}
      {state.kind === "error" ? <Text color={TUI_THEME.error}>{state.message}</Text> : null}
      {state.kind === "ready" ? (
        submenu === undefined ? (
          <ConfigList
            data={state.data}
            editing={editing}
            error={error}
            index={index}
            query={query}
            revealApiKey={revealApiKey}
            rows={rows}
            searchMode={searchMode}
            values={state.values}
            onCancelEdit={() => {
              setEditing(undefined);
              setError(undefined);
              setRevealApiKey(false);
            }}
            onToggleSecret={() => setRevealApiKey((value) => !value)}
            onUpdate={updateValue}
          />
        ) : (
          <ConfigModelMenu
            answer={submenu === "answerModel"}
            current={state.values.chatModel}
            load={loadModels}
            selected={state.values[submenu]}
            onCancel={() => setSubmenu(undefined)}
            onManual={() => {
              setEditing(submenu);
              setSubmenu(undefined);
            }}
            onSelect={(model) => {
              updateValue(submenu, model);
              setSubmenu(undefined);
            }}
          />
        )
      ) : null}
    </PanelFrame>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
