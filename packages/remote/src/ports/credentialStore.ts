import type { RemoteCredentialRecord } from "../access/accessKey";

export interface RemoteCredentialStore {
  read(): Promise<RemoteCredentialRecord | null>;
  write(record: RemoteCredentialRecord): Promise<void>;
  delete(): Promise<void>;
}
