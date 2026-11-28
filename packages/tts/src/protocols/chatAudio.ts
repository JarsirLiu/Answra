/**
 * 对话式音频协议（MiMo v2.5 TTS 系列）：POST {baseUrl}/chat/completions。
 *
 * 与 `openai-compatible` 的区别在 wire 形状：待朗读文本必须放在 `assistant` 消息，
 * 音频以 Base64 出现在 `choices[0].message.audio.data`，而不是二进制响应体。
 * 不用 `api-key` 头，官方同时支持 `Authorization: Bearer`，与其它 adapter 保持一致。
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

const CHAT_COMPLETIONS_PATH = "/chat/completions";
const AUDIO_FORMAT = "mp3";
const AUDIO_MIME_TYPE = "audio/mpeg";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const CAPABILITIES: TtsProviderCapabilities = {
  streaming: false,
  formats: [AUDIO_FORMAT],
  maxChars: TTS_DEFAULT_MAX_CHARS,
  supportsSpeed: false,
  supportsEmotion: false,
  voiceCatalog: "static",
};

export function createChatAudioProvider(options: TtsProviderOptions): TtsProviderPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const endpoint = `${trimTrailingSlash(options.baseUrl)}${CHAT_COMPLETIONS_PATH}`;

  return {
    capabilities: CAPABILITIES,

    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      if (request.text.trim() === "") {
        throw new TtsProviderError("invalid-request", "待合成文本为空。");
      }

      const voice = (request.voice ?? options.voice ?? "").trim();
      const signal = createRequestSignal(request.signal, timeoutMs);
      const body = {
        model: options.model,
        messages: [{ role: "assistant", content: request.text }],
        audio: {
          format: AUDIO_FORMAT,
          ...(voice === "" ? {} : { voice }),
        },
        stream: false,
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
      const audioBase64 = readAudioBase64(payload);
      if (audioBase64 === "") {
        throw new TtsProviderError("empty-audio", "TTS 服务返回了空音频。");
      }

      return { bytes: decodeBase64(audioBase64), mimeType: AUDIO_MIME_TYPE };
    },
  };
}

/** 只按文档形状取值；缺字段一律视为不可用响应，不做兜底猜测。 */
function readAudioBase64(payload: unknown): string {
  const choices = isRecord(payload) ? payload.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TtsProviderError("provider-rejected", "TTS 响应缺少 choices。");
  }
  const first: unknown = choices[0];
  const message = isRecord(first) ? first.message : undefined;
  const audio = isRecord(message) ? message.audio : undefined;
  const data = isRecord(audio) ? audio.data : undefined;
  if (typeof data !== "string") {
    throw new TtsProviderError("provider-rejected", "TTS 响应缺少 message.audio.data。");
  }
  return data;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw mapRequestError(error, signal);
  }
}

/** 手写解码：本包不 import Node 内置，也不假设宿主提供 `Buffer`/`atob`。 */
function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 === 1 || !BASE64_PATTERN.test(value)) {
    throw new TtsProviderError("provider-rejected", "TTS 响应中的音频不是合法 Base64。");
  }
  const clean = value.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new TtsProviderError("provider-rejected", "TTS 响应中的音频不是合法 Base64。");
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  if (offset !== bytes.byteLength) {
    throw new TtsProviderError("provider-rejected", "TTS 响应中的音频不是合法 Base64。");
  }
  return bytes;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
