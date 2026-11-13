/** CLI 服务准入凭据的 OS keychain 适配；不可用时 fail-closed，不回退明文文件。 */
import {
  type CredentialEntry,
  type CredentialEntryFactory,
  CredentialStoreUnavailableError,
} from "@answra/credentials";
import {
  parseServiceAuthRecord,
  type ServiceAuthRecord,
  type ServiceAuthStore,
} from "./serviceAuthStore";

export const REMOTE_SERVICE_AUTH_SERVICE = "Answra";
export const REMOTE_SERVICE_AUTH_ACCOUNT = "remote-service-auth";

export interface KeychainServiceAuthStoreOptions {
  service?: string;
  account?: string;
  createEntry?: CredentialEntryFactory;
}

export class KeychainServiceAuthStore implements ServiceAuthStore {
  private readonly service: string;
  private readonly account: string;
  private readonly createEntry: CredentialEntryFactory;
  private entry?: Promise<CredentialEntry>;

  constructor(options: KeychainServiceAuthStoreOptions = {}) {
    this.service = options.service ?? REMOTE_SERVICE_AUTH_SERVICE;
    this.account = options.account ?? REMOTE_SERVICE_AUTH_ACCOUNT;
    this.createEntry = options.createEntry ?? createSystemEntry;
  }

  async read(): Promise<ServiceAuthRecord | null> {
    const password = (await this.load()).getPassword();
    if (password === null || password === "") return null;
    try {
      return parseServiceAuthRecord(JSON.parse(password) as unknown);
    } catch (error) {
      throw new CredentialStoreUnavailableError("服务登录凭据损坏，请重新登录。", {
        cause: error,
      });
    }
  }

  async write(record: ServiceAuthRecord): Promise<void> {
    (await this.load()).setPassword(JSON.stringify(record));
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
        throw new CredentialStoreUnavailableError("系统凭据库不可用，无法保存登录状态。", {
          cause: error,
        });
      });
    }
    return this.entry;
  }
}

export function createKeychainServiceAuthStore(
  options: KeychainServiceAuthStoreOptions = {},
): ServiceAuthStore {
  return new KeychainServiceAuthStore(options);
}

async function createSystemEntry(service: string, account: string): Promise<CredentialEntry> {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(service, account);
}
