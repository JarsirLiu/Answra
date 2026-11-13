import { describe, expect, it } from "vitest";
import {
  createRemoteCredentialRecord,
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  hashRemoteAccessKeySecret,
  isRemoteHostAccessKeyActive,
  parseRemoteAccessKey,
  REMOTE_ACCESS_KEY_DEFAULT_DAYS,
  REMOTE_ACCESS_KEY_MAX_DAYS,
  REMOTE_ACCESS_KEY_MIN_DAYS,
} from "../src";
import { createMemoryCredentialStore, createMemoryHostKeyStore } from "../src/testing";

const NOW = new Date("2026-11-13T00:00:00.000Z");

describe("remote access keys", () => {
  it("generates a parseable key with stable ids and the default seven-day expiry", () => {
    const generated = generateRemoteAccessKey({ now: NOW });

    expect(generated.key).toMatch(/^answra1\.[0-9a-f]{32}\.[0-9a-f]{16}\.[0-9a-f]{64}$/);
    expect(generated.createdAt).toBe(NOW.toISOString());
    expect(generated.expiresAt).toBe("2026-11-20T00:00:00.000Z");
    expect(parseRemoteAccessKey(generated.key)).toEqual({
      version: "answra1",
      roomId: generated.roomId,
      keyId: generated.keyId,
      secret: generated.secret,
    });
    expect(REMOTE_ACCESS_KEY_DEFAULT_DAYS).toBe(7);
  });

  it("normalizes pasted keys and rejects malformed or mismatched segments", () => {
    const generated = generateRemoteAccessKey({ now: NOW });
    expect(parseRemoteAccessKey(`  ${generated.key.toUpperCase()}  `).keyId).toBe(generated.keyId);

    expect(() => parseRemoteAccessKey("")).toThrow();
    expect(() => parseRemoteAccessKey(`preview.${generated.key}`)).toThrow();
    expect(() => parseRemoteAccessKey(`${generated.key}.extra`)).toThrow();
    expect(() => parseRemoteAccessKey(generated.key.replace(/.$/, "g"))).toThrow();
  });

  it("enforces the seven-to-thirty-day window", () => {
    expect(() =>
      generateRemoteAccessKey({ now: NOW, days: REMOTE_ACCESS_KEY_MIN_DAYS - 1 }),
    ).toThrow();
    expect(() =>
      generateRemoteAccessKey({ now: NOW, days: REMOTE_ACCESS_KEY_MAX_DAYS + 1 }),
    ).toThrow();
    expect(() => generateRemoteAccessKey({ now: NOW, days: 7.5 })).toThrow();

    const generated = generateRemoteAccessKey({ now: NOW, days: 30 });
    expect(generated.expiresAt).toBe("2026-12-13T00:00:00.000Z");
  });

  it("stores only a secret hash on the host", async () => {
    const generated = generateRemoteAccessKey({ now: NOW });
    const record = await createRemoteHostAccessKeyRecord(generated, { label: " office " });

    expect(record).toMatchObject({
      roomId: generated.roomId,
      keyId: generated.keyId,
      label: "office",
      createdAt: generated.createdAt,
      expiresAt: generated.expiresAt,
    });
    expect(record.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.secretHash).toBe(await hashRemoteAccessKeySecret(generated.secret));
    expect(JSON.stringify(record)).not.toContain(generated.secret);
    expect(record).not.toHaveProperty("key");
  });

  it("creates a controller credential and memory stores enforce revocation", async () => {
    const generated = generateRemoteAccessKey({ now: NOW });
    const hostKeys = createMemoryHostKeyStore();
    const credentials = createMemoryCredentialStore();
    const hostRecord = await createRemoteHostAccessKeyRecord(generated, { label: "laptop" });
    const credential = createRemoteCredentialRecord(generated.key, {
      savedAt: NOW,
      expiresAt: hostRecord.expiresAt,
    });

    await hostKeys.save(hostRecord);
    await credentials.write(credential);

    expect(await hostKeys.getByKeyId(generated.keyId)).toEqual(hostRecord);
    expect(await credentials.read()).toEqual(credential);
    expect(isRemoteHostAccessKeyActive(hostRecord, NOW)).toBe(true);
    expect(await hostKeys.revoke(generated.keyId, NOW.toISOString())).toBe(true);
    const revoked = await hostKeys.getByKeyId(generated.keyId);
    if (revoked === null) throw new Error("revoked key missing");
    expect(isRemoteHostAccessKeyActive(revoked, NOW)).toBe(false);
    expect(await hostKeys.revoke("missing", NOW.toISOString())).toBe(false);

    await credentials.delete();
    expect(await credentials.read()).toBeNull();
  });

  it("rejects invalid labels", async () => {
    const generated = generateRemoteAccessKey({ now: NOW });
    await expect(
      createRemoteHostAccessKeyRecord(generated, { label: "line\nbreak" }),
    ).rejects.toThrow();
    await expect(
      createRemoteHostAccessKeyRecord(generated, { label: "x".repeat(65) }),
    ).rejects.toThrow();
  });
});
