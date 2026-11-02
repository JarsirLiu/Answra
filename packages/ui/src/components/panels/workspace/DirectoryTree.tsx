import type { WorkspaceNode } from "@answra/shared";
import { addCollection, Icon } from "@iconify/react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getIconForFile } from "vscode-icons-js";
import { ICON_SM } from "../../../tokens";
import "./DirectoryTree.css";

const iconAssetPath = new URL("assets/vscode-icons.js", document.baseURI).href;
let iconCollectionLoad: Promise<void> | undefined;
type VscodeIconCollection = Parameters<typeof addCollection>[0];

function loadVscodeIconCollection(): Promise<void> {
  if (!iconCollectionLoad) {
    iconCollectionLoad = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = iconAssetPath;
      script.onload = () => {
        const collection = window.__ANSWRA_VSCODE_ICON_SET__;
        if (!collection) {
          reject(new Error("VS Code 图标集资源未注册"));
          return;
        }
        addCollection(collection);
        resolve();
      };
      script.onerror = () => reject(new Error("VS Code 图标集资源加载失败"));
      document.head.append(script);
    });
  }
  return iconCollectionLoad;
}

declare global {
  interface Window {
    __ANSWRA_VSCODE_ICON_SET__?: VscodeIconCollection;
  }
}

/** 文件名 → VS Code 图标。vscode-icons-js 返回 "file_type_markdown.svg"，下划线转连字符即为 Iconify 键。 */
function fileIconId(name: string): string {
  const icon = getIconForFile(name);
  if (!icon) return "vscode-icons:default-file";
  return `vscode-icons:${icon.replace(/\.svg$/, "").replace(/_/g, "-")}`;
}

/** 目录图标与文件徽标同属 VS Code 图标集，开合两态各一。 */
const FOLDER_ICON = "vscode-icons:default-folder";
const FOLDER_OPEN_ICON = "vscode-icons:default-folder-opened";

interface DirectoryTreeProps {
  nodes: WorkspaceNode[];
  selectedPath: string | null;
  onSelect: (node: WorkspaceNode) => void;
  onDelete: (path: string) => void;
}

/**
 * 目录树纯展示组件：根目录路径与收起入口都在面板头部，本组件只渲染树本身。
 * 数据是扁平先序列表（目录优先、父在子前），层级由路径推导。
 */
export function DirectoryTree({ nodes, selectedPath, onSelect, onDelete }: DirectoryTreeProps) {
  const [iconsReady, setIconsReady] = useState(false);
  const [iconLoadError, setIconLoadError] = useState<string | null>(null);
  useEffect(() => {
    void loadVscodeIconCollection().then(
      () => setIconsReady(true),
      (error: unknown) =>
        setIconLoadError(error instanceof Error ? error.message : "VS Code 图标集加载失败"),
    );
  }, []);
  // 顶层节点 = 路径不含「/」；嵌套节点只在展开的父目录内渲染，避免整表重放成重复行。
  const rootNodes = nodes.filter((node) => !node.path.includes("/"));
  return (
    <div className="workspace-tree">
      <div className="workspace-tree__body">
        {iconLoadError && (
          <p className="workspace-tree__empty" role="status">
            {iconLoadError}
          </p>
        )}
        {nodes.length === 0 ? (
          <p className="workspace-tree__empty">目录为空。</p>
        ) : (
          <ul className="workspace-tree__list">
            {rootNodes.map((node) => (
              <TreeNodeView
                key={node.path}
                depth={0}
                node={node}
                nodes={nodes}
                onDelete={onDelete}
                onSelect={onSelect}
                iconsReady={iconsReady}
                selectedPath={selectedPath}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface TreeNodeProps {
  iconsReady: boolean;
  nodes: WorkspaceNode[];
  selectedPath: string | null;
  onSelect: (node: WorkspaceNode) => void;
  onDelete: (path: string) => void;
  node: WorkspaceNode;
  depth: number;
}

function TreeNodeView({
  node,
  depth,
  nodes,
  selectedPath,
  onSelect,
  onDelete,
  iconsReady,
}: TreeNodeProps) {
  // 顶层目录默认展开；嵌套目录默认收起，由用户点击开合。
  const [expandedByUser, setExpandedByUser] = useState(depth === 0 && node.kind === "dir");
  const isDir = node.kind === "dir";
  const directChildren = isDir
    ? nodes.filter((child) => {
        if (!child.path.startsWith(`${node.path}/`)) return false;
        return !child.path.slice(node.path.length + 1).includes("/");
      })
    : [];
  const selected = selectedPath === node.path;
  return (
    <li>
      <div className={`workspace-tree__row${selected ? " workspace-tree__row--selected" : ""}`}>
        <button
          type="button"
          className="workspace-tree__item"
          aria-expanded={isDir ? expandedByUser : undefined}
          onClick={() => {
            if (isDir) setExpandedByUser((value) => !value);
            else onSelect(node);
          }}
        >
          {/* 文件也保留 chevron 空槽：图标与文件名全树同列对齐。 */}
          <span className="workspace-tree__chevron">
            {isDir &&
              (expandedByUser ? (
                <ChevronDown aria-hidden="true" size={ICON_SM} />
              ) : (
                <ChevronRight aria-hidden="true" size={ICON_SM} />
              ))}
          </span>
          {isDir ? (
            <Icon
              aria-hidden="true"
              className="workspace-tree__icon-vscode"
              fontSize={16}
              icon={expandedByUser ? FOLDER_OPEN_ICON : FOLDER_ICON}
            />
          ) : (
            <TreeFileIcon iconsReady={iconsReady} name={node.name} />
          )}
          <span className="workspace-tree__name">{node.name}</span>
        </button>
        <button
          type="button"
          className="workspace-tree__delete"
          aria-label={`删除 ${node.name}`}
          onClick={() => onDelete(node.path)}
        >
          <Trash2 aria-hidden="true" size={ICON_SM} />
        </button>
      </div>
      {isDir && expandedByUser && (
        <ul className="workspace-tree__children">
          {directChildren.map((child) => (
            <TreeNodeView
              key={child.path}
              depth={depth + 1}
              node={child}
              nodes={nodes}
              onDelete={onDelete}
              onSelect={onSelect}
              iconsReady={iconsReady}
              selectedPath={selectedPath}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TreeFileIcon({ name, iconsReady }: { name: string; iconsReady: boolean }) {
  if (!iconsReady) return <span className="workspace-tree__icon-vscode" aria-hidden="true" />;
  return (
    <Icon
      aria-hidden="true"
      className="workspace-tree__icon-vscode"
      fontSize={16}
      icon={fileIconId(name)}
    />
  );
}
