import { describe, expect, it } from "vitest";
import {
  remoteCommandSchema,
  remoteErrorSchema,
  remoteFrameSchema,
  remoteModelSettingsViewSchema,
  signalingFrameSchema,
} from "../src/schema";

const eventEnvelope = {
  schemaVersion: 1,
  eventId: "event-1",
  conversationId: "conversation-1",
  runId: "run-1",
  attemptId: "attempt-1",
  sequence: 1,
  aggregateRevision: 1,
  producerId: "host-1",
  occurredAt: "2026-11-13T00:00:00.000Z",
  event: { type: "text-delta", partId: "text-1", delta: "hello" },
} as const;

describe("remote frame schema", () => {
  it("round-trips handshake, command result, snapshot and event frames", () => {
    const hello = {
      type: "hello",
      protocolVersion: 1,
      role: "controller",
      sessionId: "session-1",
      peerId: "controller-1",
      capabilities: ["coding", "model-settings"],
    } as const;
    expect(remoteFrameSchema.parse(hello)).toEqual(hello);

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

    const commandOk = { type: "command-ok", requestId: "request-1", value: { runId: "run-1" } };
    expect(remoteFrameSchema.parse(commandOk)).toEqual(commandOk);

    const snapshot = {
      type: "snapshot",
      snapshot: { conversationId: "conversation-1", eventRevision: 0, messages: [] },
    };
    expect(remoteFrameSchema.parse(snapshot)).toEqual(snapshot);

    const event = { type: "event", event: eventEnvelope };
    expect(remoteFrameSchema.parse(event)).toEqual(event);
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
    ]) {
      expect(
        remoteErrorSchema.parse({ code, message: "remote failure", retryable: false }),
      ).toEqual({ code, message: "remote failure", retryable: false });
    }
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
    expect(
      remoteCommandSchema.safeParse({
        ...command,
        command: { ...command.command, accessToken: "secret" },
      }).success,
    ).toBe(false);
  });
});

describe("signaling frame schema", () => {
  it("round-trips room join and WebRTC negotiation frames", () => {
    const join = {
      type: "join",
      roomId: "room-1",
      peerId: "controller-1",
      role: "controller",
      protocolVersion: 1,
    } as const;
    const offer = { type: "offer", fromPeerId: "controller-1", sdp: "v=0" } as const;
    const candidate = {
      type: "ice-candidate",
      fromPeerId: "controller-1",
      candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    } as const;

    expect(signalingFrameSchema.parse(join)).toEqual(join);
    expect(signalingFrameSchema.parse(offer)).toEqual(offer);
    expect(signalingFrameSchema.parse(candidate)).toEqual(candidate);
  });
});
