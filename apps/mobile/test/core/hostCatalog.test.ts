import type { RemoteCredentialRecord } from "@answra/remote";
import { describe, expect, it } from "vitest";
import {
  createHostSummary,
  DEFAULT_HOST_LABEL,
  markHostConnected,
  markHostError,
} from "../../src/core/controller/hostCatalog";

const RECORD: RemoteCredentialRecord = {
  key: "answra1.room.key.secret",
  roomId: "room",
  keyId: "key",
  savedAt: "2026-11-22T00:00:00.000Z",
};

describe("host catalog", () => {
  it("projects a credential record without exposing the connection key", () => {
    expect(createHostSummary(RECORD)).toEqual({
      keyId: "key",
      roomId: "room",
      label: DEFAULT_HOST_LABEL,
      lastConnectedAt: null,
      lastErrorCode: null,
    });
  });

  it("keeps the stored label and last used timestamp", () => {
    expect(
      createHostSummary({
        ...RECORD,
        label: "书房电脑",
        lastUsedAt: "2026-11-21T10:00:00.000Z",
      }),
    ).toMatchObject({
      label: "书房电脑",
      lastConnectedAt: "2026-11-21T10:00:00.000Z",
    });
  });

  it("records a successful connection and clears the previous error", () => {
    const failed = markHostError(createHostSummary(RECORD), "key-revoked");

    expect(markHostConnected(failed, "2026-11-22T12:00:00.000Z")).toEqual({
      keyId: "key",
      roomId: "room",
      label: DEFAULT_HOST_LABEL,
      lastConnectedAt: "2026-11-22T12:00:00.000Z",
      lastErrorCode: null,
    });
  });

  it("records a stable error code without changing the last connection time", () => {
    const connected = markHostConnected(createHostSummary(RECORD), "2026-11-22T12:00:00.000Z");

    expect(markHostError(connected, "remote-unreachable")).toMatchObject({
      lastConnectedAt: "2026-11-22T12:00:00.000Z",
      lastErrorCode: "remote-unreachable",
    });
  });
});
