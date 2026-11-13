import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRemoteCredentialRecord,
  createRemoteHostAccessKeyRecord,
  generateRemoteAccessKey,
  isRemoteHostAccessKeyActive,
} from "@answra/remote";
import { afterEach, describe, expect, it } from "vitest";
import { createFileRemoteCredentialStore } from "../src/remote/credentials/fileRemoteCredentialStore";
import { createFileRemoteHostKeyStore } from "../src/remote/credentials/fileRemoteHostKeyStore";

const NOW = new Date("2026-11-13T00:00:00.000Z");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.length = 0;
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "answra-remote-"));
  directories.push(directory);
  return directory;
}

describe("remote key file stores", () => {
  it("persists host records with hashes only and revokes them across reloads", async () => {
    const directory = await createDirectory();
    const filePath = path.join(directory, "remote", "host-keys.json");
    const generated = generateRemoteAccessKey({ now: NOW });
    const record = await createRemoteHostAccessKeyRecord(generated, { label: "office" });
    const store = createFileRemoteHostKeyStore(filePath);

    await store.save(record);
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(generated.secret);
    expect(raw).toContain(record.secretHash);

    const reloaded = createFileRemoteHostKeyStore(filePath);
    const loaded = await reloaded.getByKeyId(record.keyId);
    if (loaded === null) throw new Error("host key missing");
    expect(loaded).toEqual(record);
    expect(isRemoteHostAccessKeyActive(loaded, NOW)).toBe(true);

    expect(await reloaded.revoke(record.keyId, NOW.toISOString())).toBe(true);
    expect(await reloaded.revoke("missing", NOW.toISOString())).toBe(false);
    const revoked = await createFileRemoteHostKeyStore(filePath).getByKeyId(record.keyId);
    if (revoked === null) throw new Error("revoked host key missing");
    expect(revoked.revokedAt).toBe(NOW.toISOString());
    expect(isRemoteHostAccessKeyActive(revoked, NOW)).toBe(false);
  });

  it("persists and deletes the controller credential", async () => {
    const directory = await createDirectory();
    const filePath = path.join(directory, "remote", "controller.json");
    const generated = generateRemoteAccessKey({ now: NOW });
    const credential = createRemoteCredentialRecord(generated.key, {
      savedAt: NOW,
      label: "work",
    });
    const store = createFileRemoteCredentialStore(filePath);

    await store.write(credential);
    expect(await createFileRemoteCredentialStore(filePath).read()).toEqual(credential);

    await store.delete();
    expect(await createFileRemoteCredentialStore(filePath).read()).toBeNull();
  });
});
