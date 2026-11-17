/** TUI 面板契约：面板种类与 `/config`、`/model` 的窄宿主端口；不持有 store 或会话实现。 */
import type { ConversationSessionSummary } from "@answra/shared";
import type { ConfigPanelData, ConfigSaveInput } from "./configForm";

export type TuiPanel = "config" | "model" | "status" | "sessions" | "help";

export interface ModelPickerData {
  readonly current: string;
  readonly models: readonly string[];
  readonly error?: string;
}

export interface SessionsPanelData {
  readonly current: string;
  readonly sessions: readonly ConversationSessionSummary[];
  readonly nextCursor?: string;
  readonly error?: string;
}

export interface TuiPanelHandlers {
  loadConfig(): Promise<ConfigPanelData>;
  saveConfig(input: ConfigSaveInput): Promise<void>;
  loadModels(): Promise<ModelPickerData>;
  selectModel(model: string): Promise<void>;
  loadSessions(cursor?: string): Promise<SessionsPanelData>;
  resumeSession(conversationId: string): Promise<void>;
  close(reason?: "saved" | "dismissed" | "status" | "resumed"): void;
}
