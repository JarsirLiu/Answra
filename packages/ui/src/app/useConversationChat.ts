import { useChat } from "@ai-sdk/react";
import type {
  ConversationChange,
  ConversationEvent,
  ConversationMessage,
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

const ACTIVE_CONVERSATION_ID = "active-exam-conversation";
type TerminalWaiter = { resolve: () => void; reject: (error: Error) => void };

export function useConversationChat(platform: DesktopBridge | undefined) {
  const [config, setConfig] = useState({ baseUrl: "", model: "", configured: false });
  const [activeRunId, setActiveRunId] = useState<string>();
  const [replyError, setReplyError] = useState<string>();
  const [sendPending, setSendPending] = useState(false);
  const [replyActivities, setReplyActivities] = useState<ReplyBarActivity[]>([]);
  const waiterRef = useRef<TerminalWaiter | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(undefined);
  const setMessagesRef = useRef<(messages: UIMessage[]) => void>(() => undefined);
  const cancelRequestedRef = useRef(false);
  const runCancelledRef = useRef(false);
  const runErrorRef = useRef<string | undefined>(undefined);
  const revisionRef = useRef(0);

  useEffect(() => {
    let alive = true;
    let changeQueue = Promise.resolve();
    void platform
      ?.getConversationConfig?.()
      .then(setConfig)
      .catch(() => undefined);
    const initialize = async () => {
      if (!platform) return;
      try {
        const initial = platform.createConversation
          ? await platform.createConversation(ACTIVE_CONVERSATION_ID)
          : await platform.getConversationSnapshot?.(ACTIVE_CONVERSATION_ID);
        if (!initial) return;
        if (alive && initial.revision >= revisionRef.current) {
          revisionRef.current = initial.revision;
          runIdRef.current = initial.activeRunId;
          setActiveRunId(initial.activeRunId);
          setMessagesRef.current(initial.messages.map(toUIMessage));
          if (initial.activeRunId && platform.readConversationEvents) {
            const history = await platform.readConversationEvents(ACTIVE_CONVERSATION_ID, 0);
            for (const change of history) {
              if (
                change.type === "event" &&
                change.event.runId === initial.activeRunId &&
                change.event.revision <= initial.revision
              )
                projectActivity(change, setReplyActivities, setReplyError);
            }
          }
        }
      } catch (error) {
        console.error("[conversation] failed to initialize snapshot", error);
      }
    };
    void initialize();
    const applyChange = (change: ConversationChange) => {
      if (change.type === "snapshot") {
        const next = change.snapshot;
        if (next.conversationId !== ACTIVE_CONVERSATION_ID || next.revision <= revisionRef.current)
          return;
        revisionRef.current = next.revision;
        runIdRef.current = next.activeRunId;
        setActiveRunId(next.activeRunId);
        setMessagesRef.current(next.messages.map(toUIMessage));
        if (!next.activeRunId) {
          setSendPending(false);
          if (runErrorRef.current) waiterRef.current?.reject(new Error(runErrorRef.current));
          else waiterRef.current?.resolve();
          waiterRef.current = undefined;
        }
        return;
      }
      if (change.type === "messages-appended") {
        if (
          change.conversationId !== ACTIVE_CONVERSATION_ID ||
          change.revision <= revisionRef.current
        )
          return;
        revisionRef.current = change.revision;
        runIdRef.current = change.activeRunId;
        setActiveRunId(change.activeRunId);
        return;
      }
      if (change.type === "run-finished") {
        if (
          change.conversationId !== ACTIVE_CONVERSATION_ID ||
          change.revision <= revisionRef.current
        )
          return;
        revisionRef.current = change.revision;
        runIdRef.current = undefined;
        setSendPending(false);
        runCancelledRef.current = change.message.status === "interrupted";
        setActiveRunId(undefined);
        if (runErrorRef.current) waiterRef.current?.reject(new Error(runErrorRef.current));
        else waiterRef.current?.resolve();
        waiterRef.current = undefined;
        return;
      }
      const { event } = change;
      if (event.conversationId !== ACTIVE_CONVERSATION_ID || event.revision <= revisionRef.current)
        return;
      revisionRef.current = event.revision;
      if (event.chunk.type === "error") runErrorRef.current = event.chunk.errorText;
      if (event.chunk.type === "abort") runCancelledRef.current = true;
    };
    const onChange = (change: ConversationChange) => {
      changeQueue = changeQueue
        .then(async () => {
          if (
            changeRevision(change) > revisionRef.current + 1 &&
            platform?.getConversationSnapshot
          ) {
            const recovered = await platform.getConversationSnapshot(ACTIVE_CONVERSATION_ID);
            if (recovered.revision >= revisionRef.current) {
              revisionRef.current = recovered.revision;
              runIdRef.current = recovered.activeRunId;
              setActiveRunId(recovered.activeRunId);
              setMessagesRef.current(recovered.messages.map(toUIMessage));
            }
          }
          applyChange(change);
        })
        .catch(() => applyChange(change));
    };
    const unsubscribe = platform?.onConversationChange?.(onChange);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [platform]);

  const transport = useMemo<ChatTransport<UIMessage>>(
    () => ({
      sendMessages: async ({ messages: uiMessages, abortSignal }) => {
        const user = [...uiMessages].reverse().find((message) => message.role === "user");
        if (!user) throw new Error("没有可发送的用户消息");
        if (!platform?.sendConversationMessage)
          throw new Error("本地 AI 服务未连接，请重启应用后重试");
        const text = user.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const images = user.parts.flatMap((part) =>
          part.type === "file" && part.mediaType.startsWith("image/")
            ? [{ name: part.filename ?? "image", dataUrl: part.url }]
            : [],
        );
        let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
        const queue: UIMessageChunk[] = [];
        let runId: string | undefined;
        let closed = false;
        let eventQueue = Promise.resolve();
        const flush = () => {
          while (controller && queue.length) {
            const chunk = queue.shift();
            if (!chunk) break;
            controller.enqueue(chunk);
          }
        };
        const onChange = (change: ConversationChange) => {
          if (change.type !== "event") return;
          const { event } = change;
          if (event.conversationId !== ACTIVE_CONVERSATION_ID || (runId && event.runId !== runId))
            return;
          eventQueue = eventQueue.then(async () => {
            if (closed) return;
            if (!runId) {
              earlyEvents.push(event);
              return;
            }
            if (event.runId !== runId) return;
            await acceptEvent(event);
          });
        };
        const earlyEvents: ConversationEvent[] = [];
        const unsubscribe = platform.onConversationChange?.(onChange) ?? (() => undefined);
        const abort = () => {
          if (runId) platform?.cancelConversationRun?.(runId);
        };
        const acceptEvent = async (event: ConversationEvent) => {
          const validation = await uiMessageChunkSchema().validate?.(event.chunk);
          if (!validation || validation.success === false)
            throw new Error("收到无效的 AI 消息事件");
          const chunk = validation.value;
          queue.push(chunk);
          projectActivity({ type: "event", event }, setReplyActivities, setReplyError);
          if (chunk.type === "error") runErrorRef.current = chunk.errorText;
          flush();
          if (chunk.type === "finish" || chunk.type === "abort") {
            closed = true;
            unsubscribe();
            abortSignal?.removeEventListener("abort", abort);
            try {
              controller?.close();
            } catch {
              /* The consumer already cancelled the stream. */
            }
            runIdRef.current = undefined;
            setActiveRunId(undefined);
            setSendPending(false);
            if (chunk.type === "abort") runCancelledRef.current = true;
            if (runErrorRef.current) waiterRef.current?.reject(new Error(runErrorRef.current));
            else waiterRef.current?.resolve();
            waiterRef.current = undefined;
          }
        };
        abortSignal?.addEventListener("abort", abort, { once: true });
        try {
          const result = await platform.sendConversationMessage(ACTIVE_CONVERSATION_ID, {
            text,
            images,
          });
          runId = result.runId;
          runIdRef.current = runId;
          setActiveRunId(runId);
          for (const event of earlyEvents) if (event.runId === runId) await acceptEvent(event);
          return new ReadableStream<UIMessageChunk>({
            start(streamController) {
              controller = streamController;
              flush();
              if (closed) streamController.close();
            },
            cancel() {
              closed = true;
              unsubscribe();
              abortSignal?.removeEventListener("abort", abort);
              abort();
            },
          });
        } catch (error) {
          closed = true;
          unsubscribe();
          abortSignal?.removeEventListener("abort", abort);
          throw error;
        }
      },
      reconnectToStream: async () => null,
    }),
    [platform],
  );
  const chat = useChat({ id: ACTIVE_CONVERSATION_ID, transport });
  setMessagesRef.current = chat.setMessages;
  const messages: ChatMessage[] = useMemo(
    () =>
      chat.messages.map((message) => ({
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
      })),
    [chat.messages],
  );
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

  const send = useCallback(
    async (text: string, attachments: ChatAttachment[]) => {
      if (!platform?.sendConversationMessage)
        throw new Error("本地 AI 服务未连接，请重启应用后重试");
      if (activeRunId || runIdRef.current) throw new Error("当前回复尚未完成");
      setReplyError(undefined);
      setReplyActivities([]);
      setSendPending(true);
      runErrorRef.current = undefined;
      runCancelledRef.current = false;
      cancelRequestedRef.current = false;
      let resolveTerminal: () => void = () => {};
      let rejectTerminal: (error: Error) => void = () => {};
      const terminal = new Promise<void>((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      });
      waiterRef.current = { resolve: resolveTerminal, reject: rejectTerminal };
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
        await chat.sendMessage({ text, files });
        await terminal;
        if (runCancelledRef.current) return "cancelled";
        return runIdRef.current ?? "completed";
      } catch (error) {
        setSendPending(false);
        waiterRef.current = undefined;
        throw error;
      }
    },
    [platform, activeRunId, chat.sendMessage],
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
    cancelRequestedRef.current = true;
    if (runIdRef.current) platform?.cancelConversationRun?.(runIdRef.current);
    chat.stop();
  }, [platform, chat.stop]);

  const clearMessages = useCallback(() => {
    setReplyActivities([]);
    setReplyError(undefined);
  }, []);

  return {
    activeRunId:
      chat.status === "streaming" || chat.status === "submitted" ? activeRunId : undefined,
    cancel,
    clearMessages,
    config,
    configure,
    messages,
    replyText: lastAssistant?.content ?? "",
    replyError,
    replyPending: Boolean(activeRunId || sendPending),
    replyActivities,
    send,
  };
}

function projectActivity(
  change: Extract<ConversationChange, { type: "event" }>,
  setActivities: React.Dispatch<React.SetStateAction<ReplyBarActivity[]>>,
  setError: React.Dispatch<React.SetStateAction<string | undefined>>,
): void {
  const { chunk, runId } = change.event;
  const add = (activity: ReplyBarActivity, merge = false) =>
    setActivities((current) => {
      const last = current.at(-1);
      if (merge && last?.id === activity.id && last.kind === activity.kind)
        return [...current.slice(0, -1), { ...last, text: last.text + activity.text }];
      return [...current, activity];
    });
  if (chunk.type === "text-delta")
    add({ id: chunk.id, kind: "text", label: "", text: chunk.delta }, true);
  else if (chunk.type === "reasoning-delta")
    add({ id: chunk.id, kind: "thinking", label: "思考", text: chunk.delta }, true);
  else if (chunk.type === "tool-input-start")
    add({
      id: `${chunk.toolCallId}:start`,
      kind: "tool",
      label: `工具：${chunk.title ?? chunk.toolName}`,
      text: "准备调用",
    });
  else if (chunk.type === "tool-input-delta")
    add(
      {
        id: `${chunk.toolCallId}:input`,
        kind: "tool",
        label: "工具参数",
        text: chunk.inputTextDelta,
      },
      true,
    );
  else if (chunk.type === "tool-input-available")
    add({
      id: `${chunk.toolCallId}:input-ready`,
      kind: "tool",
      label: `工具：${chunk.title ?? chunk.toolName}`,
      text: formatValue(chunk.input),
    });
  else if (chunk.type === "tool-output-available")
    add({
      id: `${chunk.toolCallId}:output`,
      kind: "tool",
      label: "工具结果",
      text: formatValue(chunk.output),
    });
  else if (chunk.type === "tool-input-error" || chunk.type === "tool-output-error")
    add({
      id: `${chunk.toolCallId}:error`,
      kind: "error",
      label: "工具失败",
      text: chunk.errorText,
    });
  else if (chunk.type === "error") {
    setError(chunk.errorText);
    add({ id: `${runId}:error`, kind: "error", label: "模型错误", text: chunk.errorText });
  } else if (chunk.type === "start")
    add({ id: `${runId}:start`, kind: "status", label: "模型已连接，等待输出", text: "" });
  else if (chunk.type === "source-url" || chunk.type === "source-document")
    add({
      id: chunk.sourceId,
      kind: "source",
      label: "来源",
      text: chunk.type === "source-url" ? (chunk.title ?? chunk.url) : chunk.title,
    });
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "工具已返回结果";
  }
}

function changeRevision(change: ConversationChange): number {
  if (change.type === "event") return change.event.revision;
  return change.type === "snapshot" ? change.snapshot.revision : change.revision;
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

function toUIMessage(message: ConversationMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...message.images.map(
        (image): FileUIPart => ({
          type: "file",
          filename: image.name,
          mediaType: image.dataUrl.startsWith("data:")
            ? image.dataUrl.slice(5, image.dataUrl.indexOf(";"))
            : "image/png",
          url: image.dataUrl,
        }),
      ),
    ],
  };
}

async function getImageMediaType(url: string): Promise<string> {
  if (url.startsWith("data:")) return url.slice(5, url.indexOf(";"));
  return await fetch(url)
    .then((response) => response.blob())
    .then((blob) => blob.type || "image/png");
}
