/** 桌面与 CLI 共用的本地模型字段归一化与合并；纯函数，不读写文件、不解析 argv。 */
import type { LocalModelConfig } from "./contracts";

export interface LocalModelPatch {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly answerModel?: string;
}

/** 去空白与尾部斜杠；空 answerModel 视为未设置。 */
export function normalizeLocalModel(local: LocalModelConfig): LocalModelConfig {
  const baseUrl = local.baseUrl.trim().replace(/\/+$/, "");
  const chatModel = local.chatModel.trim();
  const answerModel = local.answerModel?.trim() ?? "";
  return {
    baseUrl,
    chatModel,
    ...(answerModel === "" ? {} : { answerModel }),
  };
}

/**
 * 合并一次保存：patch 同时给出 baseUrl/chatModel 时替换端点，否则保留当前端点；
 * answerModel 缺省时保留当前值。与桌面端“切回云端仍保留本地端点”的行为一致。
 */
export function mergeLocalModel(
  current: LocalModelConfig,
  patch: LocalModelPatch,
): LocalModelConfig {
  const baseUrl = patch.baseUrl.trim().replace(/\/+$/, "");
  const chatModel = patch.chatModel.trim();
  const answerModel = patch.answerModel?.trim() ?? current.answerModel;
  const next =
    baseUrl || chatModel
      ? { baseUrl, chatModel }
      : { baseUrl: current.baseUrl, chatModel: current.chatModel };
  return normalizeLocalModel({
    ...next,
    ...(answerModel ? { answerModel } : {}),
  });
}
