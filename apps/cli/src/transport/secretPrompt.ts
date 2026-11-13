import type { Readable, Writable } from "node:stream";

export type SecretPrompt = (label: string) => Promise<string>;

type PromptInput = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): void;
};

export function createProcessSecretPrompt(stdin: PromptInput, stdout: Writable): SecretPrompt {
  return async (label) => {
    stdout.write(label);
    if (stdin.isTTY !== true) return (await readAll(stdin)).trim();
    return readSecret(stdin, stdout);
  };
}

async function readSecret(stdin: PromptInput, stdout: Writable): Promise<string> {
  if (stdin.setRawMode === undefined) throw new Error("当前终端不支持隐藏输入。");
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stdout.write("\n");
      action();
    };

    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") {
          finish(() => reject(new Error("已取消输入。")));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(() => resolve(value));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (character === "\u001b") continue;
        value += character;
        stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  }
  return chunks.join("");
}
