import type { RemoteHostAccessKeyRecord } from "../access/accessKey";

export interface RemoteHostKeyStore {
  list(): Promise<readonly RemoteHostAccessKeyRecord[]>;
  getByKeyId(keyId: string): Promise<RemoteHostAccessKeyRecord | null>;
  save(record: RemoteHostAccessKeyRecord): Promise<void>;
  revoke(keyId: string, revokedAt: string): Promise<boolean>;
}
