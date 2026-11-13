/** TUI 面板契约：面板种类与 `/config`、`/model` 的窄宿主端口；不持有 store 或会话实现。 */
import type { ConfigPanelData, ConfigSaveInput } from "./commands/configForm";

export type TuiPanel = "config" | "model";

export interface ModelPickerData {
  readonly current: string;
  readonly models: readonly string[];
  readonly error?: string;
}

export interface TuiPanelHandlers {
  loadConfig(): Promise<ConfigPanelData>;
  saveConfig(input: ConfigSaveInput): Promise<void>;
  loadModels(): Promise<ModelPickerData>;
  selectModel(model: string): Promise<void>;
  close(reason?: "saved" | "dismissed"): void;
}
