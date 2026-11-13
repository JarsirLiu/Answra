import type { SignalingFrame } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  type WebSocketLike,
  WebSocketSignalingChannel,
} from "../../../src/remote/signaling/webSocketSignalingChannel";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
    this.emit("close");
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createChannel() {
  const socket = new FakeSocket();
  const channel = new WebSocketSignalingChannel({
    url: "wss://example.test/api/v1/remote/signaling?ticket=one-time",
    protocols: ["answra.remote.signaling.v1"],
    createSocket: () => socket,
  });
  return { channel, socket };
}

describe("WebSocketSignalingChannel", () => {
  it("becomes open only after the socket opens and forwards valid frames", () => {
    const { channel, socket } = createChannel();
    const frames: SignalingFrame[] = [];
    channel.onFrame((frame) => frames.push(frame));

    expect(channel.state()).toBe("connecting");
    expect(() =>
      channel.send({
        type: "join",
        roomId: "room",
        peerId: "peer",
        role: "host",
        protocolVersion: 1,
      }),
    ).toThrow("not open");

    socket.open();
    expect(channel.state()).toBe("open");

    socket.message(
      JSON.stringify({
        type: "joined",
        roomId: "room",
        peerId: "peer",
        role: "host",
        peers: [],
      }),
    );

    expect(frames).toEqual([
      { type: "joined", roomId: "room", peerId: "peer", role: "host", peers: [] },
    ]);
  });

  it("serializes outgoing frames and closes on invalid incoming JSON", () => {
    const { channel, socket } = createChannel();
    socket.open();

    channel.send({
      type: "join",
      roomId: "room",
      peerId: "peer",
      role: "host",
      protocolVersion: 1,
    });
    expect(JSON.parse(socket.sent[0] ?? "")).toMatchObject({ type: "join", roomId: "room" });

    socket.message("{");
    expect(channel.state()).toBe("closed");
    expect(socket.closes).toEqual([{ code: 1000, reason: "invalid-frame" }]);
  });

  it("reports a closed socket once", () => {
    const { channel, socket } = createChannel();
    const states: string[] = [];
    channel.onState((state) => states.push(state));

    socket.open();
    socket.close();

    expect(states).toEqual(["open", "closed"]);
  });
});
