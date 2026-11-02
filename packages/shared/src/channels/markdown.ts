/** IPC contract for a standalone Markdown document window. */
export const MarkdownChannels = {
  GetDocument: "answra:markdown:get-document",
  SaveDocument: "answra:markdown:save-document",
  OpenDocument: "answra:markdown:open-document",
  ResolveImage: "answra:markdown:resolve-image",
  Changed: "answra:markdown:changed",
} as const;

export interface MarkdownDocument {
  path: string;
  name: string;
  text: string;
  mediaType: "text/markdown";
}

export interface MarkdownChannelMap {
  [MarkdownChannels.GetDocument]: { request: undefined; response: MarkdownDocument };
  [MarkdownChannels.SaveDocument]: { request: { text: string }; response: undefined };
  [MarkdownChannels.OpenDocument]: { request: undefined; response: MarkdownDocument | null };
  [MarkdownChannels.ResolveImage]: { request: { reference: string }; response: string };
  [MarkdownChannels.Changed]: { request: undefined; response: { path: string } };
}
