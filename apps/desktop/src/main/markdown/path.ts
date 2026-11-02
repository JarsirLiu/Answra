/** File association accepts only Markdown source documents. */
import path from "node:path";

export function isMarkdownPath(value: string): boolean {
  return path.extname(value).toLowerCase() === ".md";
}

/** Resolves a Markdown image reference without allowing it to leave the document directory. */
export function resolveMarkdownImagePath(documentPath: string, reference: string): string {
  const referencePath = decodeURIComponent(reference.split(/[?#]/, 1)[0] ?? "");
  if (
    referencePath.length === 0 ||
    referencePath.includes("\0") ||
    path.isAbsolute(referencePath) ||
    path.win32.isAbsolute(referencePath)
  ) {
    throw new Error("图片路径必须是文档目录内的相对路径");
  }
  const documentDirectory = path.dirname(path.resolve(documentPath));
  const imagePath = path.resolve(documentDirectory, referencePath.replace(/[\\/]/g, path.sep));
  const relativePath = path.relative(documentDirectory, imagePath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("图片路径超出文档目录");
  }
  return imagePath;
}
