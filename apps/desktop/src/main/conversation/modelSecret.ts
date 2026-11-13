/** 桌面本地模型 API Key 的 safeStorage 密文存储；共享配置只存非 secret 字段。 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

const SECRET_FILE_MODE = 0o600;

interface StoredModelSecret {
  readonly encryptedKey: string;
}

export class ModelSecretStore {
  private current: StoredModelSecret | null = null;
  private ready?: Promise<void>;

  constructor(private readonly filePath: string) {}

  init(): Promise<void> {
    if (!this.ready) this.ready = this.load();
    return this.ready;
  }

  encryptedKey(): string | undefined {
    return this.current?.encryptedKey;
  }

  async save(apiKey: string | undefined): Promise<void> {
    if (!apiKey) {
      await this.remove();
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，未能保存 API Key");
    }
    await this.persist({
      encryptedKey: safeStorage.encryptString(apiKey).toString("base64"),
    });
  }

  async importEncryptedKey(encryptedKey: string | undefined): Promise<void> {
    if (!encryptedKey) return;
    await this.init();
    if (this.current?.encryptedKey === encryptedKey) return;
    await this.persist({ encryptedKey });
  }

  async remove(): Promise<void> {
    await rm(this.filePath, { force: true });
    this.current = null;
  }

  async reveal(): Promise<string | null> {
    await this.init();
    const encrypted = this.current?.encryptedKey;
    if (!encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法读取 API Key");
    }
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  }

  private async persist(secret: StoredModelSecret): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, `${JSON.stringify(secret, null, 2)}\n`, {
      encoding: "utf8",
      mode: SECRET_FILE_MODE,
    });
    this.current = secret;
  }

  private async load(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      console.warn("[model-settings] API Key 密文无法读取", error);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredModelSecret>;
      if (typeof parsed.encryptedKey !== "string") return;
      this.current = { encryptedKey: parsed.encryptedKey };
    } catch (error) {
      console.warn("[model-settings] API Key 密文无法解析", error);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
