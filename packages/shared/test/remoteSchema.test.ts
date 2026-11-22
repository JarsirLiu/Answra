import { describe, expect, it } from "vitest";
import {
  remoteCapabilitiesSchema,
  remoteCommandSchema,
  remoteErrorSchema,
  remoteFrameSchema,
  remoteModelSettingsViewSchema,
  remoteSendResultSchema,
  signalingFrameSchema,
} from "../src/schema";

const sessionFrame = {
  schemaVersion: 2,
  sessionId: "conversation-1",
  seq: 1,
  eventId: "frame-1",
  occurredAt: "2026-11-13T00:00:00.000Z",
  producerId: "host-1",
  turnId: "turn-1",
  messageId: "message-1",
  event: { type: "text-start", partId: "text-1" },
} as const;

const liveFrame = {
  sessionId: "conversation-1",
  messageId: "message-1",
  event: { type: "text-delta", partId: "text-1", delta: "hello" },
} as const;

describe("remote frame schema", () => {
  it("accepts desktop conversation and session capabilities", () => {
    const capabilities = ["conversation", "sessions"] as const;

    expect(remoteCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
  });

  it("round-trips handshake, command result, snapshot, durable and live frames", () => {
    const hello = {
      type: "hello",
      protocolVersion: 1,
      role: "controller",
      sessionId: "session-1",
      peerId: "controller-1",
      capabilities: ["coding", "model-settings"],
    } as const;
    expect(remoteFrameSchema.parse(hello)).toEqual(hello);

    const auth = {
      type: "auth",
      sessionId: "session-1",
      roomId: "0123456789abcdef0123456789abcdef",
      keyId: "0123456789abcdef",
      secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    } as const;
    expect(remoteFrameSchema.parse(auth)).toEqual(auth);

    const welcome = {
      type: "welcome",
      protocolVersion: 1,
      sessionId: "session-1",
      hostId: "host-1",
      leaseId: "lease-1",
      capabilities: ["coding", "model-settings"],
      workspaceRoot: "D:/workspace",
      modelSettings: {
        source: "local",
        baseUrl: "http://127.0.0.1:1234/v1",
        chatModel: "local-model",
        configured: true,
      },
    } as const;
    expect(remoteFrameSchema.parse(welcome)).toEqual(welcome);

    const commandOk = { type: "command-ok", requestId: "request-1", value: { turnId: "turn-1" } };
    expect(remoteFrameSchema.parse(commandOk)).toEqual(commandOk);

    const authError = {
      type: "auth-error",
      error: { code: "unauthorized", message: "remote access key is not valid", retryable: false },
    } as const;
    expect(remoteFrameSchema.parse(authError)).toEqual(authError);

    const snapshot = {
      type: "snapshot",
      snapshot: {
        conversationId: "conversation-1",
        eventRevision: 0,
        lastSeq: 0,
        messages: [],
      },
    };
    expect(remoteFrameSchema.parse(snapshot)).toEqual(snapshot);

    const durable = { type: "session-frame", frame: sessionFrame };
    expect(remoteFrameSchema.parse(durable)).toEqual(durable);

    const live = { type: "live-frame", frame: liveFrame };
    expect(remoteFrameSchema.parse(live)).toEqual(live);
  });

  it("reads history by durable seq and rejects live deltas on the durable channel", () => {
    expect(
      remoteCommandSchema.parse({
        type: "read-frames",
        conversationId: "conversation-1",
        afterSeq: 3,
      }),
    ).toEqual({ type: "read-frames", conversationId: "conversation-1", afterSeq: 3 });
    expect(
      remoteCommandSchema.safeParse({
        type: "read-frames",
        conversationId: "conversation-1",
        afterRevision: 3,
      }).success,
    ).toBe(false);
    // `text-delta` 只走 live 通道，不得进入可重放的 durable 帧。
    expect(
      remoteFrameSchema.safeParse({
        type: "session-frame",
        frame: { ...sessionFrame, event: liveFrame.event },
      }).success,
    ).toBe(false);
  });

  it("rejects an unsupported protocol version and unknown frame fields", () => {
    expect(
      remoteFrameSchema.safeParse({
        type: "hello",
        protocolVersion: 2,
        role: "controller",
        sessionId: "session-1",
        peerId: "controller-1",
        capabilities: ["coding"],
      }).success,
    ).toBe(false);
    expect(
      remoteFrameSchema.safeParse({
        type: "hello",
        protocolVersion: 1,
        role: "controller",
        sessionId: "session-1",
        peerId: "controller-1",
        capabilities: ["coding"],
        accessToken: "secret",
      }).success,
    ).toBe(false);
  });

  it("keeps model settings frames free of API keys", () => {
    expect(
      remoteModelSettingsViewSchema.safeParse({
        source: "local",
        baseUrl: "http://127.0.0.1:1234/v1",
        chatModel: "local-model",
        configured: true,
        apiKey: "secret",
      }).success,
    ).toBe(false);
  });

  it("round-trips remote lifecycle and access-key errors", () => {
    for (const code of [
      "remote-disconnected",
      "remote-unreachable",
      "key-expired",
      "key-revoked",
      "room-conflict",
    ]) {
      expect(
        remoteErrorSchema.parse({ code, message: "remote failure", retryable: false }),
      ).toEqual({ code, message: "remote failure", retryable: false });
    }
  });

  it("validates command results instead of trusting unknown payloads", () => {
    const started = {
      queueId: "queue-1",
      status: "started",
      position: 0,
      turnId: "turn-1",
      snapshot: {
        conversationId: "conversation-1",
        eventRevision: 0,
        lastSeq: 0,
        messages: [],
      },
    } as const;
    expect(remoteSendResultSchema.parse(started)).toEqual(started);
    expect(
      remoteSendResultSchema.safeParse({
        ...started,
        turnId: undefined,
      }).success,
    ).toBe(false);
  });

  it("requires a conversation id and turn id for cancel commands", () => {
    expect(remoteCommandSchema.safeParse({ type: "cancel", turnId: "turn-1" }).success).toBe(false);
    expect(
      remoteCommandSchema.safeParse({ type: "cancel", conversationId: "conversation-1" }).success,
    ).toBe(false);
    expect(
      remoteCommandSchema.parse({
        type: "cancel",
        conversationId: "conversation-1",
        turnId: "turn-1",
      }),
    ).toEqual({ type: "cancel", conversationId: "conversation-1", turnId: "turn-1" });
  });

  it("parses host commands without access tokens", () => {
    const command = {
      type: "send",
      command: {
        operation: "chat.send",
        conversationId: "conversation-1",
        request: { text: "hello", images: [] },
      },
    } as const;
    expect(remoteCommandSchema.parse(command)).toEqual(command);

    const listSessions = {
      type: "list-sessions",
      query: { cursor: "cursor-1", limit: 50 },
    } as const;
    expect(remoteCommandSchema.parse(listSessions)).toEqual(listSessions);
    expect(
      remoteCommandSchema.safeParse({
        ...listSessions,
        query: { ...listSessions.query, scope: "interview" },
      }).success,
    ).toBe(false);
    expect(
      remoteCommandSchema.safeParse({
        ...command,
        command: { ...command.command, accessToken: "secret" },
      }).success,
    ).toBe(false);
  });
});

describe("signaling frame schema", () => {
  it("round-trips room join, acknowledgement and rejection frames", () => {
    const join = {
      type: "join",
      roomId: "room-1",
      peerId: "controller-1",
      role: "controller",
      protocolVersion: 1,
    } as const;
    const joined = {
      type: "joined",
      roomId: "room-1",
      peerId: "controller-1",
      role: "controller",
      peers: [{ peerId: "host-1", role: "host" }],
    } as const;
    const rejected = {
      type: "join-rejected",
      error: { code: "room-conflict", message: "room already has a host", retryable: false },
    } as const;

    expect(signalingFrameSchema.parse(join)).toEqual(join);
    expect(signalingFrameSchema.parse(joined)).toEqual(joined);
    expect(signalingFrameSchema.parse(rejected)).toEqual(rejected);
  });

  it("round-trips WebRTC negotiation frames", () => {
    const offer = {
      type: "offer",
      fromPeerId: "host-1",
      connectionId: "connection-1",
      sdp: "v=0",
    } as const;
    const candidate = {
      type: "ice-candidate",
      fromPeerId: "controller-1",
      connectionId: "connection-1",
      candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    } as const;

    expect(signalingFrameSchema.parse(offer)).toEqual(offer);
    expect(signalingFrameSchema.parse(candidate)).toEqual(candidate);
  });
});
