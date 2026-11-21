import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Screen } from "../ui/primitives/Screen";
import { colors, radius, spacing, typography } from "../ui/tokens";

export default function HomeScreen() {
  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>ANSWRA REMOTE</Text>
        <Text style={styles.title}>手机控制台</Text>
        <Text style={styles.body}>
          Phase 0 骨架已就位。账号登录、电脑连接和会话将在后续阶段接入。
        </Text>
      </View>

      <View style={styles.actions}>
        <Link href="/connect" asChild>
          <Pressable style={styles.primaryAction}>
            <Text style={styles.primaryActionText}>输入连接码</Text>
          </Pressable>
        </Link>
        <Link href="/settings" asChild>
          <Pressable style={styles.secondaryAction}>
            <Text style={styles.secondaryActionText}>设置</Text>
          </Pressable>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.sm,
    paddingTop: spacing.xl,
  },
  eyebrow: {
    color: colors.accent,
    fontSize: typography.eyebrow,
    fontWeight: "700",
    letterSpacing: 1.2,
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
  actions: {
    gap: spacing.md,
  },
  primaryAction: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  primaryActionText: {
    color: colors.background,
    fontSize: typography.body,
    fontWeight: "700",
  },
  secondaryAction: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: spacing.md,
  },
  secondaryActionText: {
    color: colors.ink,
    fontSize: typography.body,
    fontWeight: "600",
  },
});
