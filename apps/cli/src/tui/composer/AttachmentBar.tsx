/** 输入框上方的图片附件摘要；只渲染端口返回的附件，不读取图片。 */
import { Box, Text } from "ink";
import { type ImageAttachment, imageLabel } from "../../image/attachment";
import { TUI_THEME } from "../chrome/theme";

export function AttachmentBar({
  images,
  reading,
  showHint = true,
}: {
  images: readonly ImageAttachment[];
  reading: boolean;
  showHint?: boolean;
}) {
  if (images.length === 0 && !reading) return null;
  return (
    <Box flexDirection="column" width="100%">
      {images.length > 0 ? (
        <Box flexDirection="row" flexWrap="wrap">
          {images.map((image, index) => (
            <Box key={image.dataUrl} marginRight={1}>
              <Text color={TUI_THEME.text}>{imageLabel(index)}</Text>
              <Text dimColor wrap="truncate">
                {" "}
                {image.name}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {reading ? (
        <Text dimColor>正在读取图片…</Text>
      ) : showHint ? (
        <Text dimColor>空输入时 Backspace 删除最后一张图片</Text>
      ) : null}
    </Box>
  );
}
