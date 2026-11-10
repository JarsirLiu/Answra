import { describe, expect, it } from "vitest";
import { replaceEditText } from "../../../src/core/tool/builtin/editMatch";

describe("edit text matching", () => {
  it("replaces a unique exact match", () => {
    expect(
      replaceEditText({
        text: "alpha\nbeta\ngamma",
        oldString: "beta",
        newString: "BETA",
        replaceAll: false,
      }),
    ).toEqual({ type: "matched", text: "alpha\nBETA\ngamma", replacements: 1 });
  });

  it("refuses an ambiguous match unless replace_all is set", () => {
    const ambiguous = replaceEditText({
      text: "x\nx",
      oldString: "x",
      newString: "y",
      replaceAll: false,
    });
    const all = replaceEditText({
      text: "x\nx",
      oldString: "x",
      newString: "y",
      replaceAll: true,
    });

    expect(ambiguous).toEqual({ type: "failed", reason: "ambiguous", matches: 2 });
    expect(all).toEqual({ type: "matched", text: "y\ny", replacements: 2 });
  });

  it("matches CRLF files and normalizes the replacement to LF", () => {
    expect(
      replaceEditText({
        text: "alpha\r\nbeta\r\ngamma",
        oldString: "alpha\r\nbeta",
        newString: "alpha\r\nBETA",
        replaceAll: false,
      }),
    ).toEqual({ type: "matched", text: "alpha\nBETA\ngamma", replacements: 1 });
  });

  it("strips Read line-number prefixes only when the exact match misses", () => {
    expect(
      replaceEditText({
        text: "alpha\nbeta",
        oldString: "1\talpha\n2\tbeta",
        newString: "ALPHA\nBETA",
        replaceAll: false,
      }),
    ).toEqual({ type: "matched", text: "ALPHA\nBETA", replacements: 1 });

    expect(
      replaceEditText({
        text: "alpha\nbeta",
        oldString: "1: alpha\n2: gamma",
        newString: "unused",
        replaceAll: false,
      }),
    ).toEqual({ type: "failed", reason: "not-found", matches: 0 });
  });

  it("returns not found without falling back to fuzzy matching", () => {
    expect(
      replaceEditText({
        text: "alpha\nbeta",
        oldString: "Alpha",
        newString: "gamma",
        replaceAll: false,
      }),
    ).toEqual({ type: "failed", reason: "not-found", matches: 0 });
  });

  it("treats replacement text as a literal instead of replace tokens", () => {
    expect(
      replaceEditText({
        text: "value",
        oldString: "value",
        newString: "$& $1 $$",
        replaceAll: false,
      }),
    ).toEqual({ type: "matched", text: "$& $1 $$", replacements: 1 });
  });

  it("supports deleting matched text with an empty replacement", () => {
    expect(
      replaceEditText({
        text: "keep\nremove\nkeep",
        oldString: "remove\n",
        newString: "",
        replaceAll: false,
      }),
    ).toEqual({ type: "matched", text: "keep\nkeep", replacements: 1 });
  });
});
