/**
 * OpenAI 兼容协议：POST {baseUrl}/audio/speech。
 *
 * 成功响应是二进制音频；不信任 content-type 之外的任何提示，
 * 非音频响应一律按 `provider-rejected` 处理，不能当成功播放。
 */
import { TTS_DEFAULT_MAX_CHARS, type TtsProviderCapabilities } from "@answra/shared/tts";
import {
  DEFAULT_TTS_TIMEOUT_MS,
  type TtsProviderOptions,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "../contracts";
import {
  createRequestSignal,
  httpStatusError,
  mapRequestError,
  readErrorDetail,
  TtsProviderError,
} from "../errors";
import type { TtsProviderPort } from "../port";

const OPENAI_SPEECH_PATH = "/audio/speech";
const RESPONSE_FORMAT = "mp3";

const CAPABILITIES: TtsProviderCapabilities = {
  streaming: false,
  formats: [RESPONSE_FORMAT],
  maxChars: TTS_DEFAULT_MAX_CHARS,
  supportsSpeed: true,
  supportsEmotion: false,
  voiceCatalog: "static",
};

export function createOpenAiCompatibleProvider(options: TtsProviderOptions): TtsProviderPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const endpoint = `${trimTrailingSlash(options.baseUrl)}${OPENAI_SPEECH_PATH}`;

  return {
    capabilities: CAPABILITIES,

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      const voice = (request.voice ?? options.voice ?? "").trim();
      if (voice === "") {
        throw new TtsProviderError("not-configured", "未配置音色。");
      }
      if (request.text.trim() === "") {
        throw new TtsProviderError("invalid-request", "待合成文本为空。");
      }

      const signal = createRequestSignal(request.signal, timeoutMs);
      const endpointOptions = options.options ?? {};
      const body = {
        model: options.model,
        input: request.text,
        voice,
        response_format: RESPONSE_FORMAT,
        ...(typeof endpointOptions.speed === "number" ? { speed: endpointOptions.speed } : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        throw mapRequestError(error, signal);
      }

      if (!response.ok) {
        throw httpStatusError(response.status, await readErrorDetail(response));
      }

      const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!mimeType.toLowerCase().startsWith("audio/")) {
        throw new TtsProviderError(
          "provider-rejected",
          `TTS 端点返回的不是音频（Content-Type: ${mimeType === "" ? "缺失" : mimeType}）。`,
        );
      }

      const bytes = await readBytes(response, signal);
      if (bytes.byteLength === 0) {
        throw new TtsProviderError("empty-audio", "TTS 端点返回了空音频。");
      }
      return { bytes, mimeType };
    },
  };
}

async function readBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw mapRequestError(error, signal);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
