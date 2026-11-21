import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Screen } from "../../ui/primitives/Screen";
import { colors, spacing, typography } from "../../ui/tokens";

export default function ChatScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>会话</Text>
        <Text style={styles.body}>{conversationId}</Text>
        <Text style={styles.caption}>
          消息、发送、排队和停止将在 Phase 3 接入；连接状态只由 RemoteControllerConnection 提供。
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.sm,
  },
  title: {
    color: colors.ink,
    fontSize: typography.title,
    fontWeight: "700",
  },
  body: {
    color: colors.ink,
    fontSize: typography.body,
  },
  caption: {
    color: colors.muted,
    fontSize: typography.caption,
    lineHeight: 20,
  },
});
