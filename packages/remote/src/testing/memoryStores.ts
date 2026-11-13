import type { RemoteCredentialRecord, RemoteHostAccessKeyRecord } from "../access/accessKey";
import type { RemoteCredentialStore } from "../ports/credentialStore";
import type { RemoteHostKeyStore } from "../ports/hostKeyStore";

export function createMemoryHostKeyStore(
  initial: readonly RemoteHostAccessKeyRecord[] = [],
): RemoteHostKeyStore {
  const records = new Map(initial.map((record) => [record.keyId, { ...record }]));
  return {
    async list() {
      return [...records.values()].map((record) => ({ ...record }));
    },
    async getByKeyId(keyId) {
      const record = records.get(keyId);
      return record === undefined ? null : { ...record };
    },
    async save(record) {
      records.set(record.keyId, { ...record });
    },
    async revoke(keyId, revokedAt) {
      const record = records.get(keyId);
      if (record === undefined) return false;
      records.set(keyId, { ...record, revokedAt: record.revokedAt ?? revokedAt });
      return true;
    },
  };
}

export function createMemoryCredentialStore(
  initial: RemoteCredentialRecord | null = null,
): RemoteCredentialStore {
  let record = initial === null ? null : { ...initial };
  return {
    async read() {
      return record === null ? null : { ...record };
    },
    async write(next) {
      record = { ...next };
    },
    async delete() {
      record = null;
    },
  };
}
