import { promises as fs } from "node:fs";
import path from "node:path";
import { INTERVIEW_RESUME_FILE_MAX_BYTES, INTERVIEW_RESUME_PATH_MAX_LENGTH } from "@answra/shared";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".doc", ".docx"]);

/** 只记录系统文件框产出的简历绝对路径；renderer 不能传入任意路径，正文由 AI 读取。 */
export async function pickInterviewResume(
  window: BrowserWindow | null,
): Promise<{ fileName: string; sourcePath: string } | null> {
  const options: OpenDialogOptions = {
    title: "选择简历",
    properties: ["openFile"],
    filters: [{ name: "简历文件", extensions: ["md", "txt", "pdf", "doc", "docx"] }],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;

  const filePath = result.filePaths[0];
  if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    throw new Error("仅支持 .md、.txt、.pdf、.doc 和 .docx 简历");
  if (filePath.length > INTERVIEW_RESUME_PATH_MAX_LENGTH) throw new Error("简历路径过长");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("所选路径不是文件");
  if (stat.size > INTERVIEW_RESUME_FILE_MAX_BYTES) throw new Error("简历文件过大");
  if (stat.size === 0) throw new Error("简历内容为空");
  return { fileName: path.basename(filePath), sourcePath: filePath };
}
