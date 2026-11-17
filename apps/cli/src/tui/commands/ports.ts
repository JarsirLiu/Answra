/** TUI 命令执行端口：命令族共享的窄依赖；不 import Ink 组件、runTui 或面板实现。 */
import type { ConversationModelConfig, ManualCompactionResult } from "@answra/shared";
import type { ModelSettings } from "../../model/ports";
import type { RemoteAuthPort } from "../../remote/auth/remoteAuthService";
import type { CodingSession } from "../../session/codingSession";
import type { TuiViewStore } from "../app/viewStore";
import type { TuiPanel } from "../panels/panel";
import type { TuiRuntime } from "./access";

export interface RemoteHostHandle {
  readonly code?: string;
  readonly keyId: string;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

export interface RemoteHostInfo {
  readonly code?: string;
  readonly keyId: string;
}

export interface TuiCommandDeps {
  readonly store: TuiViewStore;
  readonly modelSettings: ModelSettings;
  /** 运行/压缩状态快照；access 策略的唯一运行时输入。 */
  readonly runtime: () => TuiRuntime;
  readonly getSession: () => CodingSession | undefined;
  readonly compactConversation: (instructions?: string) => Promise<ManualCompactionResult>;
  readonly configureSession: (model: ConversationModelConfig) => Promise<void>;
  readonly requestExit: () => void;
  readonly openPanel: (panel: TuiPanel) => void;
  readonly remoteAuth?: RemoteAuthPort;
  readonly login: () => Promise<void>;
  readonly startRemoteHost?: () => Promise<RemoteHostHandle>;
  /** 已开启的远程 host，用于 `/remote` 重新显示连接码。 */
  readonly activeRemote?: () => RemoteHostInfo | undefined;
}

export type TuiCommandHandler = (
  args: readonly string[],
  deps: TuiCommandDeps,
) => void | Promise<void>;
