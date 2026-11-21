import { describe, expect, it } from "vitest";
import { RemoteSignalingNegotiation } from "../src/signaling/negotiation";

describe("remote signaling negotiation", () => {
  it("rejects an offer delivered to a host", () => {
    const host = new RemoteSignalingNegotiation("host", "host-1");

    expect(() =>
      host.acceptOffer({
        type: "offer",
        fromPeerId: "controller-1",
        connectionId: "connection-1",
        sdp: "v=0",
      }),
    ).toThrow("unexpected remote offer");
  });

  it("rejects an answer delivered to a controller", () => {
    const controller = new RemoteSignalingNegotiation("controller", "controller-1");

    expect(() =>
      controller.acceptAnswer({
        type: "answer",
        fromPeerId: "host-1",
        connectionId: "connection-1",
        sdp: "v=0",
      }),
    ).toThrow("unexpected remote answer");
  });

  it("rejects remote ICE before the host has an answer", () => {
    const host = new RemoteSignalingNegotiation("host", "host-1");
    host.offer("offer-1", "connection-1");

    expect(() =>
      host.acceptIceCandidate({
        type: "ice-candidate",
        fromPeerId: "controller-1",
        connectionId: "connection-1",
        candidate: { candidate: "candidate:1" },
      }),
    ).toThrow("ice candidate arrived before remote SDP");
  });

  it("rejects remote ICE before the controller has an offer", () => {
    const controller = new RemoteSignalingNegotiation("controller", "controller-1");

    expect(() =>
      controller.acceptIceCandidate({
        type: "ice-candidate",
        fromPeerId: "host-1",
        connectionId: "connection-1",
        candidate: { candidate: "candidate:1" },
      }),
    ).toThrow("ice candidate arrived before remote SDP");
  });

  it("rejects an answer or candidate from an older connection generation", () => {
    const host = new RemoteSignalingNegotiation("host", "host-1");
    host.offer("offer-2", "connection-2");

    expect(() =>
      host.acceptAnswer({
        type: "answer",
        fromPeerId: "controller-1",
        connectionId: "connection-1",
        sdp: "answer-1",
      }),
    ).toThrow("another connection");

    host.acceptAnswer({
      type: "answer",
      fromPeerId: "controller-1",
      connectionId: "connection-2",
      sdp: "answer-2",
    });
    expect(() =>
      host.acceptIceCandidate({
        type: "ice-candidate",
        fromPeerId: "controller-1",
        connectionId: "connection-1",
        candidate: { candidate: "candidate:1" },
      }),
    ).toThrow("another connection");
  });
});
