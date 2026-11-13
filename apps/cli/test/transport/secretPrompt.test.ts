import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createProcessSecretPrompt } from "../../src/transport/secretPrompt";

describe("createProcessSecretPrompt", () => {
  it("reads piped input and trims surrounding whitespace", async () => {
    const stdin = Object.assign(Readable.from(["  answra1.key\n"]), { isTTY: false });
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const prompt = createProcessSecretPrompt(stdin, stdout);

    await expect(prompt("Paste access key: ")).resolves.toBe("answra1.key");
  });
});
