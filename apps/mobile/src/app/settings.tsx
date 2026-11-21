import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Screen } from "../ui/primitives/Screen";
import { colors, radius, spacing, typography } from "../ui/tokens";

export default function SettingsScreen() {
  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>设置</Text>
        <Text style={styles.body}>
          账号、SecureStore 中的电脑连接和诊断信息将在 Phase 1 接入。模型 Key、shell
          和工作区权限不会出现在手机上。
        </Text>
      </View>

      <Link href="/" asChild>
        <Pressable style={styles.action}>
          <Text style={styles.actionText}>返回</Text>
        </Pressable>
      </Link>
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
    color: colors.muted,
    fontSize: typography.body,
    lineHeight: 24,
  },
  action: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: spacing.md,
  },
  actionText: {
    color: colors.ink,
    fontSize: typography.body,
    fontWeight: "600",
  },
});
