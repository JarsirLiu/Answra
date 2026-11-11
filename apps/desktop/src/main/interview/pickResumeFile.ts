import { promises as fs } from "node:fs";
import path from "node:path";
import { INTERVIEW_RESUME_FILE_MAX_BYTES, INTERVIEW_RESUME_TEXT_MAX_CHARS } from "@answra/shared";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt"]);

/** 只允许系统文件框产出的简历路径进入主进程；renderer 不能传入任意路径。 */
export async function pickInterviewResume(
  window: BrowserWindow | null,
): Promise<{ fileName: string; text: string } | null> {
  const options: OpenDialogOptions = {
    title: "选择简历",
    properties: ["openFile"],
    filters: [{ name: "简历文本", extensions: ["md", "txt"] }],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;

  const filePath = result.filePaths[0];
  if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    throw new Error("首版仅支持 .md 和 .txt 简历");
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("所选路径不是文件");
  if (stat.size > INTERVIEW_RESUME_FILE_MAX_BYTES) throw new Error("简历文件过大");

  const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("简历内容为空");
  if (text.length > INTERVIEW_RESUME_TEXT_MAX_CHARS) throw new Error("简历内容过长");
  return { fileName: path.basename(filePath), text };
}
