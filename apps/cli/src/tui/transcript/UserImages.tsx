/** user 消息中的图片附件摘要；终端只显示标记和文件名，不渲染位图。 */
import type { ConversationViewMessage } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { imageLabel } from "../../image/attachment";
import { TUI_THEME } from "../chrome/theme";

export function UserImages({ images }: { images: NonNullable<ConversationViewMessage["images"]> }) {
  if (images.length === 0) return null;
  return (
    <Box flexDirection="column" width="100%">
      {images.map((image, index) => (
        <Box key={image.dataUrl} flexDirection="row">
          <Text color={TUI_THEME.text}>{imageLabel(index)}</Text>
          <Text color={TUI_THEME.inactive} wrap="truncate">
            {" "}
            {image.name}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
