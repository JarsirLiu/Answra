/** 工作区目录树纯展示组件：按层级展示目录与文件并支持展开/收起侧栏，不持有文件读写逻辑。 */
import type { WorkspaceNode } from "@answra/shared";
import { addCollection, Icon } from "@iconify/react";
// VS Code 图标集离线注册（Iconify 官方离线用法：导入一次，全应用可用）。
import vscodeIconsCollection from "@iconify-json/vscode-icons/icons.json";
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";
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
  /** 侧栏收起状态与切换（按钮位于树顶部工具行，不独占整列）。 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

interface TreeNodeProps extends DirectoryTreeProps {
  node: WorkspaceNode;
  depth: number;
}

export function DirectoryTree(props: DirectoryTreeProps) {
  const { nodes } = props;
  const rootNodes = nodes.filter((node) => !node.path.includes("/"));

  return (
    <div className="workspace-tree">
      {props.onToggleCollapse && (
        <div className="workspace-tree__actions">
          <button
            type="button"
            className="workspace-tree__action"
            aria-label={props.collapsed ? "展开目录" : "收起目录"}
            title={props.collapsed ? "展开目录" : "收起目录"}
            onClick={props.onToggleCollapse}
          >
            {props.collapsed ? (
              <PanelLeftOpen aria-hidden="true" size={ICON_SM} />
            ) : (
              <PanelLeftClose aria-hidden="true" size={ICON_SM} />
            )}
          </button>
        </div>
      )}
      <div className="workspace-tree__body">
        {rootNodes.length === 0 ? (
          <p className="workspace-tree__empty">目录为空。</p>
        ) : (
          <ul className="workspace-tree__list">
            {rootNodes.map((node) => (
              <TreeNodeView key={node.path} {...props} node={node} depth={0} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TreeNodeView({ node, depth, ...treeProps }: TreeNodeProps) {
  const { selectedPath, onSelect, nodes, onDelete } = treeProps;
  const [expanded, setExpanded] = useState(depth === 0 && node.kind === "dir");
  const isDir = node.kind === "dir";
  const directChildren = isDir
    ? nodes.filter((child) => {
        if (!child.path.startsWith(`${node.path}/`)) return false;
        const rest = child.path.slice(node.path.length + 1);
        return !rest.includes("/");
      })
    : [];
  const selected = selectedPath === node.path;
  return (
    <li>
      <div className={`workspace-tree__row${selected ? " workspace-tree__row--selected" : ""}`}>
        <button
          type="button"
          className="workspace-tree__item"
          aria-expanded={isDir ? expanded : undefined}
          onClick={() => {
            if (isDir) setExpanded((value) => !value);
            else onSelect(node);
          }}
        >
          {isDir ? (
            <>
              <span className="workspace-tree__chevron">
                {expanded ? (
                  <ChevronDown aria-hidden="true" size={ICON_SM} />
                ) : (
                  <ChevronRight aria-hidden="true" size={ICON_SM} />
                )}
              </span>
              <Icon
                aria-hidden="true"
                className="workspace-tree__icon-vscode"
                fontSize={16}
                icon={expanded ? FOLDER_OPEN_ICON : FOLDER_ICON}
              />
            </>
          ) : (
            <>
              <span aria-hidden="true" className="workspace-tree__chevron" />
              <TreeFileIcon name={node.name} />
            </>
          )}
          <span className="workspace-tree__name">{node.name}</span>
        </button>
        <button
          type="button"
          className="workspace-tree__delete"
          aria-label={`删除 ${node.name}`}
          onClick={() => onDelete(node.path)}
        >
          <Trash2 aria-hidden="true" size={ICON_SM - 2} />
        </button>
      </div>
      {isDir && expanded && directChildren.length > 0 && (
        <ul className="workspace-tree__children">
          {directChildren.map((child) => (
            <TreeNodeView key={child.path} {...treeProps} node={child} depth={depth + 1} />
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
