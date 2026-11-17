/** Skill 系统的公开入口：契约、目录扫描与索引渲染。 */
export { type SkillCatalog, scanSkills } from "./catalog";
export {
  SKILL_CONTENT_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_FILE_LIST_MAX_ENTRIES,
  SKILL_FILE_MAX_BYTES,
  SKILL_INDEX_MAX_ENTRIES,
  SKILL_SOURCE_PRECEDENCE,
  type SkillInfo,
  type SkillRoots,
  type SkillSourceKind,
} from "./contracts";
export { renderSkillIndex, selectSkills } from "./guidance";
