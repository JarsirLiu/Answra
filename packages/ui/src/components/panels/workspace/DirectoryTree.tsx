import type { WorkspaceNode } from "@answra/shared";
import { addCollection, Icon } from "@iconify/react";
// VS Code 图标集离线注册（Iconify 官方离线用法：导入一次，全应用可用）。
import vscodeIconsCollection from "@iconify-json/vscode-icons/icons.json";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { getIconForFile } from "vscode-icons-js";
import { ICON_SM } from "../../../tokens";
import "./DirectoryTree.css";

addCollection(vscodeIconsCollection);

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
  // 顶层节点 = 路径不含「/」；嵌套节点只在展开的父目录内渲染，避免整表重放成重复行。
  const rootNodes = nodes.filter((node) => !node.path.includes("/"));
  return (
    <div className="workspace-tree">
      <div className="workspace-tree__body">
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
  nodes: WorkspaceNode[];
  selectedPath: string | null;
  onSelect: (node: WorkspaceNode) => void;
  onDelete: (path: string) => void;
  node: WorkspaceNode;
  depth: number;
}

function TreeNodeView({ node, depth, nodes, selectedPath, onSelect, onDelete }: TreeNodeProps) {
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
            <TreeFileIcon name={node.name} />
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
              selectedPath={selectedPath}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TreeFileIcon({ name }: { name: string }) {
  return (
    <Icon
      aria-hidden="true"
      className="workspace-tree__icon-vscode"
      fontSize={16}
      icon={fileIconId(name)}
    />
  );
}
