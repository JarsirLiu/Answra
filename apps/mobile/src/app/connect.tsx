import { parseRemoteAccessKey } from "@answra/remote";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Screen } from "../ui/primitives/Screen";
import { colors, radius, spacing, typography } from "../ui/tokens";

export default function ConnectScreen() {
  const [value, setValue] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const validate = (): void => {
    try {
      const parsed = parseRemoteAccessKey(value);
      setFeedback(`连接码格式有效：${parsed.roomId.slice(0, 8)}…`);
    } catch {
      setFeedback("连接码格式无效，请检查后重试。");
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>连接电脑</Text>
        <Text style={styles.body}>
          在桌面端打开远程连接并复制连接码。Phase 0 只校验格式，SecureStore 保存将在 Phase 1 接入。
        </Text>
      </View>

      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setValue}
        placeholder="answra1.room.key.secret"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={value}
      />

      {feedback === null ? null : <Text style={styles.feedback}>{feedback}</Text>}

      <Pressable onPress={validate} style={styles.action}>
        <Text style={styles.actionText}>校验连接码</Text>
      </Pressable>
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
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.ink,
    fontSize: typography.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  feedback: {
    color: colors.muted,
    fontSize: typography.caption,
  },
  action: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  actionText: {
    color: colors.background,
    fontSize: typography.body,
    fontWeight: "700",
  },
});
