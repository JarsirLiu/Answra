/** 面试画像的路径、XML 格式和引导种子上下文；只读渲染，不承载文件读写或会话状态。 */
import {
  INTERVIEW_PROFILE_FILE,
  INTERVIEW_PROFILE_VERSION,
  type InterviewProfileSeed,
} from "@answra/shared";

export const INTERVIEW_MEMORY_FILE = INTERVIEW_PROFILE_FILE;

/** 画像 XML 的唯一格式说明；intake 写入和演练读取共用，避免两份格式漂移。 */
export const INTERVIEW_PROFILE_FORMAT = [
  `画像文件是 ${INTERVIEW_PROFILE_FILE}，格式如下：`,
  `<profile version="${INTERVIEW_PROFILE_VERSION}" updated="ISO 时间">`,
  "  <target-role>目标岗位</target-role>",
  "  <resume><file>文件名</file><path>绝对路径</path></resume>",
  '  <projects><project id="稳定 id"><name>项目名</name><location>仓库或本地路径</location><summary>一句话</summary></project></projects>',
  "  <memory>自由文本：经历、优势、披露边界、待确认项等</memory>",
  '  <history><change at="ISO 时间" source="ai">改动说明</change></history>',
  "</profile>",
].join("\n");

/** 只有 intake 使用；演练官拿到的画像上下文是只读的。 */
export const INTERVIEW_PROFILE_WRITE_RULES = [
  "用户换简历、改项目地址、补充或修正经历时，直接更新对应字段，不要另建第二份画像，也不要把旧信息留在冲突位置。",
  "修改时保留未知字段和 <memory> 内容，更新 updated，并向 <history> 追加一条记录；保持 XML 合法，没有对应字段的新事实写进 <memory>。",
  "文本中的 &、<、> 要写成 &amp;、&lt;、&gt;；属性值里的引号也要转义，确保 XML 合法。",
].join("\n");

export function buildInterviewMemorySystemContext(
  root: string | null,
  seed: InterviewProfileSeed | null = null,
): string {
  const lines = [
    "# 面试画像记忆",
    root
      ? `私有记忆目录：${root}`
      : "本次会话没有可用的私有记忆目录；不要猜测记忆文件路径，也不要声称已经读写记忆。",
  ];
  if (root) {
    lines.push(
      `画像文件：${root}/${INTERVIEW_MEMORY_FILE}`,
      "画像按需读取；不要把全文自动放进上下文。",
    );
  }
  const seedLines = renderSeed(seed);
  if (seedLines.length > 0) lines.push("", ...seedLines);
  return lines.join("\n");
}

/** 引导只作为画像的初始输入；画像已存在时以画像和用户当前指令为准。 */
function renderSeed(seed: InterviewProfileSeed | null): string[] {
  if (!seed) return [];
  const hasData = Boolean(seed.targetRole.trim() || seed.resume || seed.projects.length > 0);
  if (!hasData) return [];
  const lines = [
    "# 引导资料（只读）",
    `最近引导更新：${seed.updatedAt}`,
    `目标岗位：${seed.targetRole.trim() || "未填写"}`,
  ];
  if (seed.resume) {
    lines.push(`简历：${seed.resume.fileName}（${seed.resume.sourcePath}）`);
  } else {
    lines.push("简历：未选择");
  }
  if (seed.projects.length > 0) {
    lines.push("项目：");
    for (const project of seed.projects) {
      const parts = [project.name];
      if (project.location) parts.push(`位置：${project.location}`);
      if (project.summary) parts.push(`说明：${project.summary}`);
      lines.push(`- ${parts.join("；")}`);
    }
  } else {
    lines.push("项目：未选择");
  }
  lines.push(
    "用途：画像不存在时由资料整理者用它创建；画像已存在时只补缺失字段，不覆盖已有内容。用户明确说改过简历或项目时，再按这份资料更新对应字段；用户当前指令永远优先。",
  );
  return lines;
}
