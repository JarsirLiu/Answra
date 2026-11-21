import type { RemoteCredentialRecord } from "@answra/remote";

/** host 连接码的 secret 存储；实现必须写入 OS 安全存储，不能回退明文。 */
export interface HostCredentialStore {
  save(record: RemoteCredentialRecord): Promise<void>;
  read(keyId: string): Promise<RemoteCredentialRecord | null>;
  list(): Promise<readonly RemoteCredentialRecord[]>;
  remove(keyId: string): Promise<void>;
}
