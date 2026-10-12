import type { DesktopBridge, WorkspaceChangeSet, WorkspaceNode } from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { NOTE_MIGRATED_FLAG, NOTE_STORAGE_KEY } from "../../../model";

/**
 * 工作区数据层 hook：封装 workspace IPC（选目录/目录树/变更订阅），
 * UI 组件不直接触碰 bridge 细节。
 */
export interface WorkspaceState {
  root: string | null;
  tree: WorkspaceNode[];
  loading: boolean;
  error: string | null;
  pickRoot: () => Promise<void>;
  refreshTree: () => Promise<void>;
  createEntry: (path: string, kind: "dir" | "file") => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
}

export function useWorkspace(bridge: DesktopBridge | undefined): WorkspaceState {
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<WorkspaceNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<string | null>(null);
  rootRef.current = root;

  const refreshTree = useCallback(async () => {
    if (!bridge?.listWorkspaceTree || !rootRef.current) return;
    try {
      setTree(await bridge.listWorkspaceTree());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取目录失败");
    }
  }, [bridge]);

  // 初始恢复上次根目录；选择/恢复成功后拉取目录树。
  useEffect(() => {
    if (!bridge?.getWorkspaceRoot) return;
    let cancelled = false;
    void bridge
      .getWorkspaceRoot()
      .then(({ root: restored }) => {
        if (cancelled) return;
        if (restored) {
          rootRef.current = restored;
          setRoot(restored);
          setLoading(true);
          void bridge
            .listWorkspaceTree?.()
            .then((nodes) => !cancelled && setTree(nodes))
            .catch(() => undefined)
            .finally(() => !cancelled && setLoading(false));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const pickRoot = useCallback(async () => {
    if (!bridge?.pickWorkspaceRoot || !bridge.listWorkspaceTree) return;
    try {
      setError(null);
      const { root: picked } = await bridge.pickWorkspaceRoot();
      if (!picked) return;
      rootRef.current = picked;
      setRoot(picked);
      setLoading(true);
      setTree(await bridge.listWorkspaceTree());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "选择目录失败");
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  const createEntry = useCallback(
    async (path: string, kind: "dir" | "file") => {
      if (!bridge?.createWorkspaceEntry) return;
      await bridge.createWorkspaceEntry({ path, kind });
      await refreshTree();
    },
    [bridge, refreshTree],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (!bridge?.deleteWorkspaceEntry) return;
      await bridge.deleteWorkspaceEntry(path);
      await refreshTree();
    },
    [bridge, refreshTree],
  );

  // watcher 推送 → 刷新目录树（编辑器/预览自行按路径决定是否刷新）。
  useEffect(() => {
    if (!bridge?.onWorkspaceChanged) return;
    const unsubscribe = bridge.onWorkspaceChanged((_change: WorkspaceChangeSet) => {
      void refreshTree();
    });
    return unsubscribe;
  }, [bridge, refreshTree]);

  // 旧版 localStorage 笔记一次性迁移：首个工作区根目录可用时写入
  // 「未迁移笔记.md」；迁移标记与原 localStorage 值都保留，防静默丢失。
  useEffect(() => {
    if (!root || !bridge?.createWorkspaceEntry || !bridge.writeWorkspaceFile) return;
    const legacy = localStorage.getItem(NOTE_STORAGE_KEY) ?? "";
    if (localStorage.getItem(NOTE_MIGRATED_FLAG) === "1" || legacy.trim().length === 0) {
      localStorage.setItem(NOTE_MIGRATED_FLAG, "1");
      return;
    }
    void (async () => {
      try {
        await bridge.createWorkspaceEntry?.({ path: "未迁移笔记.md", kind: "file" });
        await bridge.writeWorkspaceFile?.("未迁移笔记.md", legacy);
        localStorage.setItem(NOTE_MIGRATED_FLAG, "1");
      } catch {
        // 目标文件已存在等情况：保留 localStorage 原值，下次仍可迁移。
      }
    })();
  }, [bridge, root]);

  return { root, tree, loading, error, pickRoot, refreshTree, createEntry, deleteEntry };
}
