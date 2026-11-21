import path from "node:path";
import { resolveDefaultConfigDir } from "@answra/config";
import { createJsonRemoteHostKeyStore, type RemoteHostKeyStore } from "@answra/remote";
import { readProtectedJson, writeProtectedJson } from "./jsonFile";

export function createFileRemoteHostKeyStore(
  filePath: string = defaultRemoteHostKeyPath(),
): RemoteHostKeyStore {
  return createJsonRemoteHostKeyStore({
    read: () => readProtectedJson(filePath),
    write: (value) => writeProtectedJson(filePath, value),
  });
}

export function defaultRemoteHostKeyPath(): string {
  return path.join(resolveDefaultConfigDir(), "remote", "host-keys.json");
}
