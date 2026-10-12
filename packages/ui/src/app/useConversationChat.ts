import { useChat } from "@ai-sdk/react";
import type {
  ConversationEvent,
  ConversationModelConfig,
  DesktopBridge,
  ReplyBarActivity,
} from "@answra/shared";
import {
  type ChatTransport,
  type FileUIPart,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment, ChatMessage } from "../components/panels/ChatPanel";

export function useConversationChat(platform: DesktopBridge | undefined) {
  const [config, setConfig] = useState({ baseUrl: "", model: "", configured: false });
  const [activeRunId, setActiveRunId] = useState<string>();
  const [replyError, setReplyError] = useState<string>();
  const [replyPending, setReplyPending] = useState(false);
  const [replyActivities, setReplyActivities] = useState<ReplyBarActivity[]>([]);
  const runIdRef = useRef<string | undefined>(undefined);
  const terminalWaiter = useRef<
    { resolve: (errorText?: string) => void; reject: (error: Error) => void } | undefined
  >(undefined);
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
        let runError: string | undefined;
        let eventQueue = Promise.resolve();
        const earlyEvents: ConversationEvent[] = [];
        const flush = () => {
          while (streamController && chunks.length) {
            const chunk = chunks.shift();
            if (chunk) streamController.enqueue(chunk);
          }
        };
        const handleEvent = async (event: ConversationEvent) => {
          if (stopped) return;
          if (event.runId !== runId) return;
          const validation = await uiMessageChunkSchema().validate?.(event.chunk);
          if (!validation || validation.success === false)
            throw new Error("收到无效的 AI 消息事件");
          chunks.push(validation.value);
          const chunk = validation.value;
          const addActivity = (activity: ReplyBarActivity, merge = false) => {
            setReplyActivities((current) => {
              const last = current.at(-1);
              if (merge && last?.id === activity.id && last.kind === activity.kind)
                return [...current.slice(0, -1), { ...last, text: last.text + activity.text }];
              return [...current, activity];
            });
          };
          if (chunk.type === "text-delta")
            addActivity({ id: chunk.id, kind: "text", label: "回答", text: chunk.delta }, true);
          else if (chunk.type === "reasoning-delta")
            addActivity({ id: chunk.id, kind: "thinking", label: "思考", text: chunk.delta }, true);
          else if (chunk.type === "tool-input-start")
            addActivity({
              id: `${chunk.toolCallId}:input-start`,
              kind: "tool",
              label: `工具：${chunk.title ?? chunk.toolName}`,
              text: "准备调用",
            });
          else if (chunk.type === "tool-input-delta")
            addActivity(
              {
                id: `${chunk.toolCallId}:input-delta`,
                kind: "tool",
                label: "工具参数",
                text: chunk.inputTextDelta,
              },
              true,
            );
          else if (chunk.type === "tool-input-available")
            addActivity({
              id: `${chunk.toolCallId}:input-ready`,
              kind: "tool",
              label: `工具：${chunk.title ?? chunk.toolName}`,
              text: JSON.stringify(chunk.input),
            });
          else if (chunk.type === "tool-input-error" || chunk.type === "tool-output-error")
            addActivity({
              id: `${chunk.toolCallId}:${chunk.type}`,
              kind: "error",
              label: "工具失败",
              text: chunk.errorText,
            });
          else if (chunk.type === "tool-output-available")
            addActivity({
              id: `${chunk.toolCallId}:output`,
              kind: "tool",
              label: "工具结果",
              text: formatActivityValue(chunk.output),
            });
          else if (chunk.type === "tool-output-denied")
            addActivity({
              id: `${chunk.toolCallId}:denied`,
              kind: "status",
              label: "工具调用已拒绝",
              text: "",
            });
          else if (chunk.type === "error")
            addActivity({
              id: `error-${Date.now()}`,
              kind: "error",
              label: "模型错误",
              text: chunk.errorText,
            });
          else if (chunk.type === "source-url" || chunk.type === "source-document")
            addActivity({
              id: chunk.sourceId,
              kind: "source",
              label: "来源",
              text: chunk.type === "source-url" ? (chunk.title ?? chunk.url) : chunk.title,
            });
          else if (chunk.type === "file")
            addActivity({
              id: `file-${Date.now()}`,
              kind: "status",
              label: "模型生成文件",
              text: chunk.mediaType,
            });
          else if (chunk.type === "start")
            addActivity({
              id: "run-start",
              kind: "status",
              label: "模型已连接，等待输出",
              text: "",
            });
          if (event.chunk.type === "error") {
            runError = event.chunk.errorText;
            setReplyError(runError);
          }
          if (event.chunk.type === "abort") runError = "__cancelled__";
          if (event.chunk.type === "finish" || event.chunk.type === "abort") {
            stopped = true;
            terminal = true;
            unsubscribe();
            abortSignal?.removeEventListener("abort", abort);
            setActiveRunId(undefined);
            setReplyPending(false);
            runIdRef.current = undefined;
            flush();
            try {
              streamController?.close();
            } catch {
              /* Stream was cancelled by the consumer. */
            }
            terminalWaiter.current?.resolve(runError);
            terminalWaiter.current = undefined;
            return;
          }
          flush();
        };
        const onEvent = (event: ConversationEvent) => {
          if (!runId) {
            earlyEvents.push(event);
            return;
          }
          eventQueue = eventQueue
            .then(() => handleEvent(event))
            .catch((error: unknown) => {
              chunks.push(
                {
                  type: "error",
                  errorText: error instanceof Error ? error.message : "AI 消息事件无效",
                },
                { type: "finish", finishReason: "error" },
              );
              stopped = true;
              terminal = true;
              unsubscribe();
              abortSignal?.removeEventListener("abort", abort);
              setActiveRunId(undefined);
              setReplyPending(false);
              runIdRef.current = undefined;
              flush();
              try {
                streamController?.close();
              } catch {
                /* Stream was cancelled by the consumer. */
              }
              terminalWaiter.current?.reject(
                error instanceof Error ? error : new Error("AI 消息事件无效"),
              );
              terminalWaiter.current = undefined;
            });
        };
        const unsubscribe = platform.onConversationEvent?.(onEvent) ?? (() => undefined);
        const abort = () => {
          if (runId) platform.cancelConversationRun?.(runId);
        };
        abortSignal?.addEventListener("abort", abort, { once: true });

        try {
          const result = await platform.sendConversationMessage({ text, images });
          runId = result.runId;
          if (!terminal) {
            runIdRef.current = runId;
            setActiveRunId(runId);
            setReplyPending(true);
          }
          for (const event of earlyEvents) {
            eventQueue = eventQueue.then(() => handleEvent(event));
          }
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
              setReplyPending(false);
              terminalWaiter.current?.resolve();
              terminalWaiter.current = undefined;
              if (runId) platform.cancelConversationRun?.(runId);
            },
          });
        } catch (error) {
          stopped = true;
          unsubscribe();
          abortSignal?.removeEventListener("abort", abort);
          setReplyPending(false);
          terminalWaiter.current?.reject(error instanceof Error ? error : new Error("发送失败"));
          terminalWaiter.current = undefined;
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
      setReplyError(undefined);
      setReplyActivities([]);
      setReplyPending(true);
      const completed = new Promise<string | undefined>((resolve, reject) => {
        terminalWaiter.current = { resolve, reject };
      });
      try {
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
        const errorText = await completed;
        if (errorText === "__cancelled__") return "cancelled";
        if (errorText) throw new Error(errorText);
        return runIdRef.current ?? "completed";
      } catch (error) {
        setReplyPending(false);
        terminalWaiter.current = undefined;
        throw error;
      }
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
    setReplyPending(false);
    terminalWaiter.current?.resolve();
    terminalWaiter.current = undefined;
    stop();
  }, [platform, stop]);

  const clearMessages = useCallback(() => {
    cancel();
    setMessages([]);
    setActiveRunId(undefined);
    setReplyPending(false);
    setReplyError(undefined);
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
    replyError,
    replyPending,
    replyActivities,
    send,
  };
}

function formatActivityValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "工具已返回结果";
  }
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
