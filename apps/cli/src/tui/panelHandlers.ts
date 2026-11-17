/** TUI 面板动作：配置、模型与会话历史；只调用运行控制器和持久化端口。 */
import type { ModelCredentialStore } from "@answra/credentials";
import type { ConversationModelConfig } from "@answra/shared";
import type { ModelCatalog } from "../model/catalog";
import type { ModelSettings } from "../model/ports";
import type { TuiViewStore } from "./app/viewStore";
import { assertAccessAllowed, PANEL_ACTION_ACCESS } from "./commands/access";
import type { TuiPanelHandlers } from "./panels/panel";
import type { TuiRunController } from "./runController";

const SESSION_PAGE_SIZE = 20;

export interface TuiPanelHandlerOptions {
  readonly store: TuiViewStore;
  readonly runController: TuiRunController;
  readonly modelSettings: ModelSettings;
  readonly modelCredentials: ModelCredentialStore;
  readonly modelCatalog: ModelCatalog;
  readonly ensureSession: (model: ConversationModelConfig, accessToken?: string) => Promise<void>;
}

export function createTuiPanelHandlers({
  store,
  runController,
  modelSettings,
  modelCredentials,
  modelCatalog,
  ensureSession,
}: TuiPanelHandlerOptions): TuiPanelHandlers {
  return {
    loadConfig: async () => {
      const snapshot = await modelSettings.snapshot();
      const apiKey = await modelCredentials.read();
      return {
        baseUrl: snapshot.local.baseUrl,
        chatModel: snapshot.local.chatModel,
        ...(snapshot.local.answerModel === undefined
          ? {}
          : { answerModel: snapshot.local.answerModel }),
        apiKey: apiKey ?? "",
      };
    },
    saveConfig: async (input) => {
      assertAccessAllowed(PANEL_ACTION_ACCESS.saveConfig, runController.runtime());
      const before = await modelSettings.snapshot();
      const model = await modelSettings.addLocal({
        baseUrl: input.baseUrl,
        chatModel: input.chatModel,
        ...(input.answerModel === undefined ? {} : { answerModel: input.answerModel }),
      });
      let accessToken: string;
      if (input.apiKey.kind === "set") {
        await modelCredentials.write(input.apiKey.value);
        accessToken = input.apiKey.value;
      } else if (input.apiKey.kind === "clear") {
        await modelCredentials.clear();
        accessToken = "";
      } else {
        accessToken = (await modelCredentials.read()) ?? "";
      }
      const activeSession = runController.activeSession;
      if (activeSession === undefined) {
        await ensureSession(model, accessToken);
      } else {
        activeSession.setModel(model);
        activeSession.setAccessToken(accessToken);
      }
      store.clearError();
      store.setModelLabel(model.chat.model);
      store.setModelConfigured(true);
      store.setSetupStep(undefined);
      const changes: string[] = [];
      if (before.local.baseUrl !== input.baseUrl) {
        changes.push(`Set baseUrl to ${input.baseUrl}`);
      }
      if (before.local.chatModel !== input.chatModel) {
        changes.push(`Set chatModel to ${input.chatModel}`);
      }
      if ((before.local.answerModel ?? "") !== (input.answerModel ?? "")) {
        changes.push(`Set answerModel to ${input.answerModel ?? "(none)"}`);
      }
      if (input.apiKey.kind === "set") changes.push("Set API key");
      else if (input.apiKey.kind === "clear") changes.push("Cleared API key");
      store.notify({
        key: "model",
        text: changes.length === 0 ? "Config dialog dismissed" : changes.join("\n"),
        tone: "success",
      });
    },
    loadModels: async () => {
      const snapshot = await modelSettings.snapshot();
      const current = snapshot.local.chatModel;
      if (!snapshot.configured || snapshot.local.baseUrl.trim() === "") {
        return {
          current,
          models: [],
          error: "尚未配置本地模型，请先打开 /config。",
        };
      }
      try {
        const apiKey = (await modelCredentials.read()) ?? undefined;
        const models = await modelCatalog.list({
          baseUrl: snapshot.local.baseUrl,
          ...(apiKey === undefined ? {} : { apiKey }),
        });
        return { current, models };
      } catch (error) {
        return { current, models: [], error: messageOf(error) };
      }
    },
    selectModel: async (modelId) => {
      assertAccessAllowed(PANEL_ACTION_ACCESS.selectModel, runController.runtime());
      const model = await modelSettings.switchChatModel(modelId);
      const activeSession = runController.activeSession;
      if (activeSession === undefined) {
        await ensureSession(model);
      } else {
        activeSession.setModel(model);
      }
      store.clearError();
      store.setModelLabel(model.chat.model);
      store.setModelConfigured(true);
      store.setSetupStep(undefined);
      store.notify({
        key: "model",
        text: `已切换模型：${model.chat.model}`,
        tone: "success",
      });
    },
    loadSessions: async (cursor) => {
      const activeSession = runController.activeSession;
      if (activeSession === undefined) {
        return { current: "", sessions: [], error: "尚未配置模型，无法读取会话历史。" };
      }
      try {
        const page = await activeSession.listSessions({
          limit: SESSION_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          current: activeSession.currentConversationId,
          sessions: page.items,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      } catch (error) {
        return {
          current: activeSession.currentConversationId,
          sessions: [],
          error: messageOf(error),
        };
      }
    },
    resumeSession: async (conversationId) => {
      assertAccessAllowed(PANEL_ACTION_ACCESS.resumeSession, runController.runtime());
      const activeSession = runController.activeSession;
      if (activeSession === undefined) throw new Error("尚未配置模型。");
      if (conversationId === activeSession.currentConversationId) return;
      await runController.activate(conversationId);
      store.notify({
        key: "session",
        text: `已恢复会话：${conversationId}`,
        tone: "success",
      });
    },
    close: (reason) => {
      const panel = store.getSnapshot().panel;
      store.setPanel(undefined);
      if (
        reason === "dismissed" &&
        (panel === undefined || panel === "config" || panel === "model")
      ) {
        store.notify({ key: "model", text: "Config dialog dismissed", tone: "success" });
      }
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
