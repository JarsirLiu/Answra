import { describe, expect, it } from "vitest";
import {
  decodeRemoteFrame,
  decodeSignalingFrame,
  encodeRemoteFrame,
  encodeSignalingFrame,
} from "../src";

describe("remote frame codec", () => {
  it("round-trips a valid frame through JSON", () => {
    const frame = {
      type: "command",
      requestId: "request-1",
      command: { type: "list-bots" },
    } as const;

    expect(decodeRemoteFrame(encodeRemoteFrame(frame))).toEqual(frame);
  });

  it("round-trips the dedicated access-key auth frame", () => {
    const frame = {
      type: "auth",
      sessionId: "session-1",
      roomId: "0123456789abcdef0123456789abcdef",
      keyId: "0123456789abcdef",
      secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    } as const;

    expect(decodeRemoteFrame(encodeRemoteFrame(frame))).toEqual(frame);
  });

  it("rejects malformed or unsupported frames at the boundary", () => {
    expect(() => decodeRemoteFrame("{not-json")).toThrow();
    expect(() =>
      decodeRemoteFrame(
        JSON.stringify({
          type: "hello",
          protocolVersion: 99,
          role: "controller",
          sessionId: "session-1",
          peerId: "controller-1",
          capabilities: ["coding"],
        }),
      ),
    ).toThrow();
  });

  it("rejects extra secret-bearing fields", () => {
    expect(() =>
      decodeRemoteFrame(
        JSON.stringify({
          type: "command",
          requestId: "request-1",
          command: {
            type: "send",
            command: {
              operation: "chat.send",
              conversationId: "conversation-1",
              request: { text: "hello", images: [] },
              accessToken: "secret",
            },
          },
        }),
      ),
    ).toThrow();
  });
});

describe("signaling frame codec", () => {
  it("round-trips a room join frame", () => {
    const frame = {
      type: "join",
      roomId: "room-1",
      peerId: "host-1",
      role: "host",
      protocolVersion: 1,
    } as const;

    expect(decodeSignalingFrame(encodeSignalingFrame(frame))).toEqual(frame);
  });
});
