import type { HostSummary } from "../controller/hostCatalog";

/** host 列表的非 secret 元数据存储；不得写入完整连接码。 */
export interface HostSummaryStore {
  list(): Promise<readonly HostSummary[]>;
  save(summary: HostSummary): Promise<void>;
  remove(keyId: string): Promise<void>;
}
