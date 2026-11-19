/** AGENTS.md 指令上下文公开入口：契约、加载与渲染。 */

export {
  createInstructionLoader,
  discoverProjectInstructionFiles,
  type InstructionLoaderOptions,
  type LoadInstructionFilesOptions,
  loadInstructionFiles,
} from "./catalog";
export type {
  InstructionFile,
  InstructionLoader,
} from "./contracts";
export { INSTRUCTION_FILE_MAX_BYTES } from "./contracts";
export { renderInstructionContext } from "./guidance";
