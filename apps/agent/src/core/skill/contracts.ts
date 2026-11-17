/** Skill 的唯一契约：来源根目录、扫描产物与索引预算；不含扫描实现与提示词策略。 */

/**
 * skill 的三类来源根目录。`null` 表示该来源不存在；
 * 不做任何兜底推断——缺省即"没有此类 skill"，绝不回退到猜测目录。
 */
export interface SkillRoots {
  /** 随包发布的内置 skill 目录；由宿主解析，agent 不认识物理位置。 */
  readonly builtin: string | null;
  /** 用户级 skill 目录（同类跨项目复用）。 */
  readonly user: string | null;
  /** 当前工作区 skill 目录；只在用户打开某工作区时存在。 */
  readonly workspace: string | null;
}

/** 单个 skill 的扫描结果；`content` 是 frontmatter 之后的正文。 */
export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  /** skill 文件所在目录；工具输出用它标注 scripts/reference 的相对基准。 */
  readonly directory: string;
  readonly content: string;
  readonly source: SkillSourceKind;
}

/** 来源种类，同时决定同名覆盖优先级：数值大的覆盖数值小的。 */
export type SkillSourceKind = "builtin" | "user" | "workspace";

/** 同名覆盖优先级；工作区最贴近当前任务，因此最高。 */
export const SKILL_SOURCE_PRECEDENCE: Readonly<Record<SkillSourceKind, number>> = {
  builtin: 0,
  user: 1,
  workspace: 2,
};

/** 单条 description 的字符上限；超出截断，避免索引被长描述撑爆。 */
export const SKILL_DESCRIPTION_MAX_CHARS = 500;

/** 进入索引的 skill 条数上限；超出按 name 排序取前 N 并向模型声明已截断。 */
export const SKILL_INDEX_MAX_ENTRIES = 100;

/** Skill 工具返回正文的字符上限；超出提示模型正文被截断。 */
export const SKILL_CONTENT_MAX_CHARS = 40_000;

/** 工具输出中列出的同目录文件条数上限；只给路径，不给内容。 */
export const SKILL_FILE_LIST_MAX_ENTRIES = 10;

/** skill 文件大小上限；超过直接跳过，避免把巨型文档当 skill 读入内存。 */
export const SKILL_FILE_MAX_BYTES = 512_000;
