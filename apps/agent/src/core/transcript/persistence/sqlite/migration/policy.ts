/** 发布阶段开关：首次发布时改为 released，之后 migration 进入 append-only。 */
export type MigrationPolicy = "pre-release" | "released";

export const MIGRATION_POLICY: MigrationPolicy = "pre-release";
