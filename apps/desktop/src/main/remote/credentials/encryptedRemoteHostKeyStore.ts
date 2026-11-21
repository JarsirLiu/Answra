import { createJsonRemoteHostKeyStore, type RemoteHostKeyStore } from "@answra/remote";
import { readEncryptedJson, writeEncryptedJson } from "../../auth/secureFile";

const HOST_KEY_FILE = "remote-host.bin";

export function createEncryptedRemoteHostKeyStore(configDir: string): RemoteHostKeyStore {
  return createJsonRemoteHostKeyStore({
    read: () => readEncryptedJson(configDir, HOST_KEY_FILE, (value) => value),
    write: (value) => writeEncryptedJson(configDir, HOST_KEY_FILE, value),
  });
}
