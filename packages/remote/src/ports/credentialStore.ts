/** 远程访问密钥的平台存储端口；shared config 不保存 secret。 */
export interface RemoteCredentialStore {
  read(): Promise<string | null>;
  write(secret: string): Promise<void>;
  delete(): Promise<void>;
}
