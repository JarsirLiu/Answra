/** 唯一通知渲染：只展示 viewStore 的当前通知；队列、优先级与超时由通知中心持有。 */
import { Box, Text } from "ink";
import { TUI_THEME } from "../chrome/theme";
import type { TuiNotification, TuiNotificationTone } from "./notification";

export function NotificationLine({ notification }: { notification: TuiNotification | null }) {
  if (notification === null) return null;
  const color = notificationToneColor(notification.tone);
  return (
    <Box flexShrink={0} paddingX={1}>
      <Text color={color} dimColor={color === undefined} wrap="wrap">
        {notification.text}
      </Text>
    </Box>
  );
}

export function notificationToneColor(tone: TuiNotificationTone | undefined): string | undefined {
  switch (tone) {
    case "success":
      return TUI_THEME.success;
    case "warning":
      return TUI_THEME.warning;
    case "error":
      return TUI_THEME.error;
    default:
      return undefined;
  }
}
