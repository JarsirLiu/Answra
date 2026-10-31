import type { DesktopBridge, WorkspaceFileContent, WorkspaceNode } from "@answra/shared";
import { FolderOpen, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ICON_SM } from "../../../tokens";
import { Tooltip } from "../../controls/Tooltip";
import { PanelShell } from "../PanelShell";
import { DirectoryTree } from "./DirectoryTree";
import { DocxPreviewPane } from "./DocxPreviewPane";
import { classifyFile } from "./fileKind";
import { type EditorViewMode, MarkdownEditorPane } from "./MarkdownEditorPane";
import { PdfPreviewPane } from "./PdfPreviewPane";
import { TextPreviewPane } from "./TextPreviewPane";
import { useWorkspace } from "./useWorkspace";
import { ZoomablePreview } from "./ZoomablePreview";
import "./WorkspacePanel.css";

interface WorkspacePanelProps {
  bridge: DesktopBridge | undefined;
  onClose: () => void;
  stealth?: boolean;
}

/**
 * 工作区面板（笔记本 + 资料合并表面）：
 * 标准面板头部（标题 = 根目录路径，动作 = 收起目录 / 更换目录 / 关闭），
 * 左目录树、右内容区（md 编辑/预览、docx/pdf 预览、图片查看）。
 * 由悬浮条唯一的「笔记本」入口打开（笔记与资料共用本面板）。
 */
export function WorkspacePanel({ bridge, onClose, stealth = false }: WorkspacePanelProps) {
  const workspace = useWorkspace(bridge, stealth);
  const [selected, setSelected] = useState<WorkspaceNode | null>(null);
  const [content, setContent] = useState<WorkspaceFileContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<EditorViewMode>("source");
  const [externalVersion, setExternalVersion] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const dirtyRef = useRef(false);
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selected?.path ?? null;

  const openNode = (node: WorkspaceNode) => {
    if (node.kind !== "file") return;
    setSelected(node);
    // md 默认打开源码编辑，预览经工具栏切换。
    setViewMode("source");
  };

  // 选中文件变化时读取内容。
  useEffect(() => {
    const path = selected?.path;
    if (!path || !bridge?.readWorkspaceFile) return;
    let cancelled = false;
    setLoadError(null);
    setContent(null);
    void bridge
      .readWorkspaceFile(path)
      .then((fileContent) => {
        if (!cancelled) setContent(fileContent);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "读取文件失败");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, selected]);

  // watcher 推送：目录树由 useWorkspace 刷新；打开中的文件由这里触发重读。
  useEffect(() => {
    if (!bridge?.onWorkspaceChanged) return;
    return bridge.onWorkspaceChanged((change) => {
      const openPath = selectedPathRef.current;
      if (!openPath) return;
      const touched = change.paths.some(
        (changedPath) => changedPath === openPath || changedPath.endsWith(`/${openPath}`),
      );
      if (touched) setExternalVersion((version) => version + 1);
    });
  }, [bridge]);

  // 外部版本变化时重读内容（md 编辑器内部有冲突保护；预览直接刷新）。
  useEffect(() => {
    const path = selected?.path;
    if (!path || externalVersion === 0 || !bridge?.readWorkspaceFile) return;
    let cancelled = false;
    void bridge
      .readWorkspaceFile(path)
      .then((fileContent) => {
        if (!cancelled) setContent(fileContent);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, externalVersion, selected]);

  const dir = selected?.path.includes("/")
    ? selected.path.slice(0, selected.path.lastIndexOf("/"))
    : "";
  const kind = selected ? classifyFile(selected.name) : null;

  return (
    <PanelShell
      context={workspace.root ? undefined : "未选择目录"}
      headerAction={
        workspace.root ? (
          <div className="panel-header-action workspace-panel__header-actions">
            <Tooltip label={sidebarCollapsed ? "展开目录" : "收起目录"}>
              <button
                type="button"
                className="workspace-panel__icon-button"
                aria-label={sidebarCollapsed ? "展开目录" : "收起目录"}
                onClick={() => setSidebarCollapsed((value) => !value)}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen aria-hidden="true" size={ICON_SM + 2} />
                ) : (
                  <PanelLeftClose aria-hidden="true" size={ICON_SM + 2} />
                )}
              </button>
            </Tooltip>
            <Tooltip label="更换目录">
              <button
                type="button"
                className="workspace-panel__icon-button workspace-panel__pick-root"
                aria-label="更换目录"
                onClick={() => void workspace.pickRoot()}
              >
                <FolderOpen aria-hidden="true" size={ICON_SM + 2} />
              </button>
            </Tooltip>
          </div>
        ) : undefined
      }
      onClose={onClose}
      title={workspace.root ?? "笔记本 / 资料"}
      variant="notes"
    >
      <div className="workspace-panel">
        {workspace.root && !sidebarCollapsed && (
          <aside aria-label="工作区目录" className="workspace-panel__sidebar">
            <DirectoryTree
              nodes={workspace.tree}
              selectedPath={selected?.path ?? null}
              onSelect={openNode}
              onDelete={(path) => {
                if (selectedPathRef.current === path) setSelected(null);
                void workspace.deleteEntry(path).catch(() => undefined);
              }}
            />
          </aside>
        )}
        <div className="workspace-panel__content">
          {!workspace.root ? (
            <div className="workspace-panel__empty">
              <p className="workspace-panel__empty-copy">
                选择一个本地目录作为工作区，目录下的 md 文档可编辑，docx/pdf 可预览。
              </p>
              <button
                type="button"
                className="surface-control surface-control--primary workspace-panel__pick"
                onClick={() => void workspace.pickRoot()}
              >
                <FolderOpen aria-hidden="true" size={14} /> 选择目录
              </button>
              {workspace.error && <div className="workspace-panel__error">{workspace.error}</div>}
            </div>
          ) : (
            <>
              {workspace.error && <div className="workspace-panel__error">{workspace.error}</div>}
              {loadError && <div className="workspace-panel__error">{loadError}</div>}
              {!selected && <div className="workspace-preview-placeholder">左侧选择文件打开</div>}
              {selected && kind === "markdown" && content && (
                <MarkdownEditorPane
                  bridge={bridge}
                  content={content}
                  dir={dir}
                  externalVersion={externalVersion}
                  path={selected.path}
                  viewMode={viewMode}
                  stealth={stealth}
                  onDirtyChange={(value) => {
                    dirtyRef.current = value;
                  }}
                  onViewModeChange={setViewMode}
                />
              )}
              {selected && kind === "docx" && content && (
                <DocxPreviewPane content={content} name={selected.name} />
              )}
              {selected && kind === "pdf" && content && (
                <PdfPreviewPane content={content} path={selected.path} />
              )}
              {selected && kind === "image" && content && (
                <ImagePreviewPane path={selected.path} name={selected.name} />
              )}
              {selected && kind === "text" && content && <TextPreviewPane content={content} />}
              {selected && kind === "other" && (
                <div className="workspace-preview-placeholder">该文件类型暂不支持应用内预览</div>
              )}
            </>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

/** 图片预览：加载完成后自动适应宽度，缩放由 `ZoomablePreview` 承担。 */
function ImagePreviewPane({ path, name }: { path: string; name: string }) {
  const [naturalWidth, setNaturalWidth] = useState<number | undefined>(undefined);
  return (
    <ZoomablePreview
      className="workspace-preview-image-zoom"
      fitSignal={naturalWidth}
      fitWidthPx={naturalWidth}
    >
      <img
        alt={name}
        className="workspace-preview-image"
        onLoad={(event) => setNaturalWidth(event.currentTarget.naturalWidth || undefined)}
        src={`answra-file:///${path}`}
      />
    </ZoomablePreview>
  );
}
