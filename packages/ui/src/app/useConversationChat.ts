import { useChat } from "@ai-sdk/react";
import type { ConversationEvent, ConversationModelConfig, DesktopBridge } from "@answra/shared";
import type { ChatTransport, FileUIPart, UIMessage, UIMessageChunk } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment, ChatMessage } from "../components/panels/ChatPanel";

export function useConversationChat(platform: DesktopBridge | undefined) {
  const [config, setConfig] = useState({ baseUrl: "", model: "", configured: false });
  const [activeRunId, setActiveRunId] = useState<string>();
  const runIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    void platform
      ?.getConversationConfig?.()
      .then(setConfig)
      .catch(() => undefined);
  }, [platform]);
  const transport = useMemo<ChatTransport<UIMessage>>(
    () => ({
      sendMessages: async ({ messages, abortSignal }) => {
        const userMessage = [...messages].reverse().find((message) => message.role === "user");
        if (!userMessage) throw new Error("没有可发送的用户消息");
        const text = userMessage.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const images = userMessage.parts.flatMap((part) =>
          part.type === "file" && part.mediaType.startsWith("image/")
            ? [{ name: part.filename ?? "image", dataUrl: part.url }]
            : [],
        );
        if (!platform?.sendConversationMessage)
          throw new Error("本地 AI 服务未连接，请重启应用后重试");

        const chunks: UIMessageChunk[] = [];
        let streamController: ReadableStreamDefaultController<UIMessageChunk> | undefined;
        let runId: string | undefined;
        let stopped = false;
        let terminal = false;
        const earlyEvents: ConversationEvent[] = [];
        const flush = () => {
          while (streamController && chunks.length) {
            const chunk = chunks.shift();
            if (chunk) streamController.enqueue(chunk);
          }
        };
        const handleEvent = (event: ConversationEvent) => {
          if (stopped) return;
          if (event.runId !== runId) return;
          if (event.type === "text/delta")
            chunks.push({ type: "text-delta", id: runId, delta: event.delta });
          if (event.type === "run/failed") chunks.push({ type: "error", errorText: event.message });
          if (
            event.type === "run/completed" ||
            event.type === "run/cancelled" ||
            event.type === "run/failed"
          ) {
            chunks.push({ type: "text-end", id: runId });
            chunks.push({ type: event.type === "run/cancelled" ? "abort" : "finish" });
            stopped = true;
            terminal = true;
            unsubscribe();
            abortSignal?.removeEventListener("abort", abort);
            setActiveRunId(undefined);
            runIdRef.current = undefined;
            flush();
            try {
              streamController?.close();
            } catch {
              /* Stream was cancelled by the consumer. */
            }
            return;
          }
          flush();
        };
        const onEvent = (event: ConversationEvent) => {
          if (!runId) {
            if (event.type === "run/started") runId = event.runId;
            earlyEvents.push(event);
            return;
          }
          handleEvent(event);
        };
        const unsubscribe = platform.onConversationEvent?.(onEvent) ?? (() => undefined);
        const abort = () => {
          if (runId) platform.cancelConversationRun?.(runId);
        };
        abortSignal?.addEventListener("abort", abort, { once: true });

        try {
          const result = await platform.sendConversationMessage({ text, images });
          runId = result.runId;
          chunks.unshift({ type: "start", messageId: runId }, { type: "text-start", id: runId });
          if (!terminal) {
            runIdRef.current = runId;
            setActiveRunId(runId);
          }
          for (const event of earlyEvents) handleEvent(event);
          flush();
          return new ReadableStream<UIMessageChunk>({
            start(controller) {
              streamController = controller;
              flush();
              if (terminal) controller.close();
            },
            cancel() {
              stopped = true;
              unsubscribe();
              abortSignal?.removeEventListener("abort", abort);
              if (runId) platform.cancelConversationRun?.(runId);
            },
          });
        } catch (error) {
          stopped = true;
          unsubscribe();
          abortSignal?.removeEventListener("abort", abort);
          throw error;
        }
      },
      reconnectToStream: async () => null,
    }),
    [platform],
  );

  const chat = useChat({ id: "ephemeral-exam-chat", transport });
  const { messages: uiMessages, sendMessage, setMessages, status, stop } = chat;

  const messages: ChatMessage[] = uiMessages.map((message) => ({
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    attachments: message.parts.flatMap((part) =>
      part.type === "file" && part.mediaType.startsWith("image/")
        ? [
            {
              id: `${message.id}-${part.url.slice(-12)}`,
              name: part.filename ?? "截图",
              previewUrl: part.url,
            },
          ]
        : [],
    ),
  }));
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const resolvedReplyText = lastAssistant?.content ?? "";

  const send = useCallback(
    async (text: string, attachments: ChatAttachment[]) => {
      if (runIdRef.current) throw new Error("当前回复尚未完成");
      const files: FileUIPart[] = await Promise.all(
        attachments.map(async (attachment) => ({
          type: "file" as const,
          filename: attachment.name,
          mediaType: await getImageMediaType(attachment.previewUrl),
          url: attachment.previewUrl.startsWith("data:")
            ? attachment.previewUrl
            : await blobUrlToDataUrl(attachment.previewUrl),
        })),
      );
      await sendMessage({ text, files });
      return runIdRef.current ?? "completed";
    },
    [sendMessage],
  );

  const configure = useCallback(
    async (next: ConversationModelConfig) => {
      if (!platform?.configureConversation) throw new Error("本地 AI 服务未连接，请重启应用后重试");
      await platform.configureConversation(next);
      setConfig({ baseUrl: next.baseUrl, model: next.model, configured: true });
    },
    [platform],
  );

  const cancel = useCallback(() => {
    if (runIdRef.current) platform?.cancelConversationRun?.(runIdRef.current);
    stop();
  }, [platform, stop]);

  const clearMessages = useCallback(() => {
    cancel();
    setMessages([]);
    setActiveRunId(undefined);
    runIdRef.current = undefined;
  }, [cancel, setMessages]);

  return {
    activeRunId: status === "streaming" || status === "submitted" ? activeRunId : undefined,
    cancel,
    clearMessages,
    config,
    configure,
    messages,
    replyText: resolvedReplyText,
    send,
  };
}

async function getImageMediaType(url: string): Promise<string> {
  if (url.startsWith("data:")) return url.slice(5, url.indexOf(";"));
  return await fetch(url)
    .then((response) => response.blob())
    .then((blob) => blob.type || "image/png");
}

async function blobUrlToDataUrl(url: string): Promise<string> {
  const blob = await fetch(url).then((response) => response.blob());
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("无法读取图片"));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}
