import { describe, expect, it } from "vitest";
import {
  formatImageReference,
  imageReferenceAfter,
  imageReferenceBefore,
  imageReferenceEndingAt,
  imageReferenceEndingBeforeCursor,
  imageReferenceStartingAt,
  imageReferences,
  referencedImageIds,
  resolveImageAttachments,
} from "../../../src/tui/composer/imageReferences";

const image = (name: string) => ({
  name,
  dataUrl: `data:image/png;base64,${name}`,
});

describe("image references", () => {
  it("formats references and keeps first-seen order without duplicates", () => {
    expect(formatImageReference(3)).toBe("[Image #3]");

    const text = "a [Image #2] b [Image #1] c [Image #2]";
    expect(imageReferences(text).map((reference) => reference.id)).toEqual([2, 1, 2]);
    expect(referencedImageIds(text)).toEqual([2, 1]);
  });

  it("ignores zero, malformed, and unknown references", () => {
    expect(referencedImageIds("[Image #0] [Image #x] [Image #] [Image #1]")).toEqual([1]);
    expect(resolveImageAttachments("[Image #1] [Image #9]", [])).toEqual([]);
  });

  it("resolves only referenced attachments in first-reference order", () => {
    const entries = [
      { id: 1, attachment: image("one") },
      { id: 2, attachment: image("two") },
    ];
    expect(resolveImageAttachments("[Image #2] [Image #1] [Image #2]", entries)).toEqual([
      image("two"),
      image("one"),
    ]);
  });

  it("locates references next to the cursor for navigation and deletion", () => {
    const text = "abc[Image #1]def";

    expect(imageReferenceEndingAt(text, 13)).toMatchObject({ start: 3, end: 13 });
    expect(imageReferenceEndingAt(text, 12)).toBeUndefined();
    expect(imageReferenceEndingBeforeCursor(`${text.slice(0, 13)} def`, 14)).toMatchObject({
      start: 3,
      end: 14,
    });
    expect(imageReferenceStartingAt(text, 3)).toMatchObject({ start: 3, end: 13 });
    expect(imageReferenceStartingAt(text, 4)).toBeUndefined();
    expect(imageReferenceBefore(text, 8)).toMatchObject({ start: 3, end: 13 });
    expect(imageReferenceBefore(text, 3)).toBeUndefined();
    expect(imageReferenceAfter(text, 8)).toMatchObject({ start: 3, end: 13 });
    expect(imageReferenceAfter(text, 13)).toBeUndefined();
  });
});
