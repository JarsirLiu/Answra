/** Notice tool detail: muted, warning, or error text. */
import { Text } from "ink";
import { TUI_THEME } from "../../../chrome/theme";

export function NoticeDetail({
  tone,
  text,
}: {
  tone: "muted" | "warning" | "error";
  text: string;
}) {
  return (
    <Text color={noticeColor(tone)} dimColor={tone === "muted"}>
      {text}
    </Text>
  );
}

function noticeColor(tone: "muted" | "warning" | "error"): string | undefined {
  if (tone === "error") return TUI_THEME.error;
  if (tone === "warning") return TUI_THEME.warning;
  return undefined;
}
