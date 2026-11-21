import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Screen } from "../../ui/primitives/Screen";
import { colors, spacing, typography } from "../../ui/tokens";

export default function HostScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>电脑</Text>
        <Text style={styles.body}>{hostId}</Text>
        <Text style={styles.caption}>
          会话列表将在 Phase 3 接入；这里只保留路由和页面装配位置。
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
