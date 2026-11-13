/** 共享本地模型凭据：OS keychain 端口与 @napi-rs/keyring 适配器；不读写模型配置文件。 */
export const MODEL_CREDENTIAL_SERVICE = "Answra";
export const MODEL_CREDENTIAL_ACCOUNT = "local-model-api-key";

export interface CredentialEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

export type CredentialEntryFactory = (service: string, account: string) => Promise<CredentialEntry>;

export interface ModelCredentialStore {
  read(): Promise<string | null>;
  write(apiKey: string): Promise<void>;
  clear(): Promise<void>;
}

export class CredentialStoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialStoreUnavailableError";
  }
}

export interface KeychainModelCredentialStoreOptions {
  readonly service?: string;
  readonly account?: string;
  readonly createEntry?: CredentialEntryFactory;
}

export class KeychainModelCredentialStore implements ModelCredentialStore {
  private readonly service: string;
  private readonly account: string;
  private readonly createEntry: CredentialEntryFactory;
  private entry?: Promise<CredentialEntry>;

  constructor(options: KeychainModelCredentialStoreOptions = {}) {
    this.service = options.service ?? MODEL_CREDENTIAL_SERVICE;
    this.account = options.account ?? MODEL_CREDENTIAL_ACCOUNT;
    this.createEntry = options.createEntry ?? createSystemEntry;
  }

  async read(): Promise<string | null> {
    const password = (await this.load()).getPassword();
    return password === null || password === "" ? null : password;
  }

  async write(apiKey: string): Promise<void> {
    const value = apiKey.trim();
    if (value === "") {
      await this.clear();
      return;
    }
    (await this.load()).setPassword(value);
  }

  async clear(): Promise<void> {
    const entry = await this.load();
    if (entry.getPassword() === null) return;
    entry.deletePassword();
  }

  private load(): Promise<CredentialEntry> {
    if (this.entry === undefined) {
      this.entry = this.createEntry(this.service, this.account).catch((error: unknown) => {
        this.entry = undefined;
        throw new CredentialStoreUnavailableError("系统凭据库不可用，无法读取或保存 API Key。", {
          cause: error,
        });
      });
    }
    return this.entry;
  }
}

export function createSystemModelCredentialStore(
  options: KeychainModelCredentialStoreOptions = {},
): ModelCredentialStore {
  return new KeychainModelCredentialStore(options);
}

async function createSystemEntry(service: string, account: string): Promise<CredentialEntry> {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(service, account);
}
