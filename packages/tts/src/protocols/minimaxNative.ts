/**
 * MiniMax 原生协议：POST {baseUrl}/v1/t2a_v2。
 *
 * 响应是 `data.audio` 的 hex；MiniMax 会用 HTTP 200 返回业务错误，
 * 因此必须检查 `base_resp.status_code`，不能只看 HTTP 状态。
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

const MINIMAX_SPEECH_PATH = "/v1/t2a_v2";
const AUDIO_MIME_TYPE = "audio/mpeg";
const HEX_PATTERN = /^[0-9a-fA-F]*$/;

const CAPABILITIES: TtsProviderCapabilities = {
  streaming: false,
  formats: ["mp3"],
  maxChars: TTS_DEFAULT_MAX_CHARS,
  supportsSpeed: false,
  supportsEmotion: false,
  voiceCatalog: "remote",
};

const AUDIO_SETTING = {
  format: "mp3",
  sample_rate: 32_000,
  bitrate: 128_000,
  channel: 1,
} as const;

export function createMinimaxNativeProvider(options: TtsProviderOptions): TtsProviderPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const endpoint = `${trimTrailingSlash(options.baseUrl)}${MINIMAX_SPEECH_PATH}`;

  return {
    capabilities: CAPABILITIES,

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      const voice = (request.voice ?? options.voice ?? "").trim();
      if (voice === "") {
        throw new TtsProviderError("not-configured", "未配置 MiniMax 音色。");
      }
      if (request.text.trim() === "") {
        throw new TtsProviderError("invalid-request", "待合成文本为空。");
      }

      const signal = createRequestSignal(request.signal, timeoutMs);
      const body = {
        model: options.model,
        text: request.text,
        stream: false,
        voice_setting: { voice_id: voice },
        audio_setting: AUDIO_SETTING,
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

      const payload = await readJson(response, signal);
      const baseResp = isRecord(payload) ? payload.base_resp : undefined;
      const statusCode = isRecord(baseResp) ? baseResp.status_code : undefined;
      if (typeof statusCode === "number" && statusCode !== 0) {
        const statusMessage =
          isRecord(baseResp) && typeof baseResp.status_msg === "string" ? baseResp.status_msg : "";
        const detail = statusMessage === "" ? "" : `：${statusMessage}`;
        throw new TtsProviderError("provider-rejected", `MiniMax 返回错误 ${statusCode}${detail}`);
      }

      const data = isRecord(payload) ? payload.data : undefined;
      const audioHex = isRecord(data) ? data.audio : undefined;
      if (typeof audioHex !== "string") {
        throw new TtsProviderError("provider-rejected", "MiniMax 响应缺少 data.audio。");
      }
      if (audioHex === "") {
        throw new TtsProviderError("empty-audio", "MiniMax 返回了空音频。");
      }

      return { bytes: decodeHex(audioHex), mimeType: AUDIO_MIME_TYPE };
    },
  };
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw mapRequestError(error, signal);
  }
}

function decodeHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new TtsProviderError("provider-rejected", "MiniMax 返回的音频 hex 长度为奇数。");
  }
  if (!HEX_PATTERN.test(value)) {
    throw new TtsProviderError("provider-rejected", "MiniMax 返回的音频 hex 含非法字符。");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
