/** 用系统默认浏览器打开登录页；失败由调用方决定是否只打印 URL。 */
import { spawn } from "node:child_process";

export type OpenBrowser = (url: string) => Promise<void>;

export async function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
