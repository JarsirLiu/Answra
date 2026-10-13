import type { WorkspaceNode } from "@answra/shared";
import { addCollection, Icon } from "@iconify/react";
// VS Code 图标集离线注册（Iconify 官方离线用法：导入一次，全应用可用）。
import vscodeIconsCollection from "@iconify-json/vscode-icons/icons.json";
import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Trash2,
  X,
} from "lucide-react";
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

interface DirectoryTreeProps {
  nodes: WorkspaceNode[];
  selectedPath: string | null;
  onSelect: (node: WorkspaceNode) => void;
  onDelete: (path: string) => void;
  /** 侧栏收起状态与切换（按钮并入树头部动作行，不独占竖条）。 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

interface TreeNodeProps extends DirectoryTreeProps {
  node: WorkspaceNode;
  depth: number;
  /** 小写筛选词；空串表示未筛选。 */
  needle: string;
  /** 该节点自身或任一后代命中筛选。 */
  matches: (node: WorkspaceNode) => boolean;
}

/** 目录树纯展示组件；筛选/展开交互在本组件内，数据由 useWorkspace 提供。 */
export function DirectoryTree(props: DirectoryTreeProps) {
  const { nodes } = props;
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();

  const matches = (node: WorkspaceNode): boolean => {
    if (needle.length === 0) return true;
    if (node.name.toLowerCase().includes(needle)) return true;
    return (
      node.kind === "dir" &&
      nodes.some(
        (child) =>
          child.path.startsWith(`${node.path}/`) && child.name.toLowerCase().includes(needle),
      )
    );
  };

  const visibleRoots = nodes.filter(matches);

  if (nodes.length === 0) return <p className="workspace-tree__empty">目录为空。</p>;

  return (
    <div className="workspace-tree">
      <div className="workspace-tree__filter">
        <Search aria-hidden="true" size={12} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="筛选文件…"
          aria-label="筛选文件"
        />
        {filter && (
          <button
            type="button"
            className="workspace-tree__filter-clear"
            aria-label="清除筛选"
            onClick={() => setFilter("")}
          >
            <X aria-hidden="true" size={12} />
          </button>
        )}
      </div>
      <div className="workspace-tree__actions">
        {props.onToggleCollapse && (
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
        )}
      </div>
      {visibleRoots.length === 0 ? (
        <p className="workspace-tree__empty">没有匹配的文件。</p>
      ) : (
        <ul className="workspace-tree__list">
          {visibleRoots.map((node) => (
            <TreeNodeView
              key={node.path}
              {...props}
              needle={needle}
              matches={matches}
              node={node}
              depth={0}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TreeNodeView({ node, depth, needle, matches, ...treeProps }: TreeNodeProps) {
  const { selectedPath, onSelect, nodes, onDelete } = treeProps;
  const [expandedByUser, setExpandedByUser] = useState(depth === 0 && node.kind === "dir");
  const isDir = node.kind === "dir";
  const childNodes = isDir ? nodes.filter((child) => child.path.startsWith(`${node.path}/`)) : [];
  const directChildren = childNodes.filter((child) => {
    const rest = child.path.slice(node.path.length + 1);
    return !rest.includes("/") && matches(child);
  });
  // 筛选时忽略用户手动展开状态：有命中后代即自动展开，保证结果可见。
  const expanded = needle.length > 0 ? directChildren.length > 0 : expandedByUser;
  const selected = selectedPath === node.path;
  return (
    <li>
      <div className={`workspace-tree__row${selected ? " workspace-tree__row--selected" : ""}`}>
        <button
          type="button"
          className="workspace-tree__item"
          aria-expanded={isDir ? expanded : undefined}
          onClick={() => {
            if (isDir) setExpandedByUser((value) => !value);
            else onSelect(node);
          }}
          title={node.path}
        >
          {isDir ? (
            <span className="workspace-tree__chevron">
              {expanded ? (
                <ChevronDown aria-hidden="true" size={ICON_SM} />
              ) : (
                <ChevronRight aria-hidden="true" size={ICON_SM} />
              )}
            </span>
          ) : (
            // 文件图标与文件夹箭头同列起点（VS Code 式对齐），不加占位符。
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
          <Trash2 aria-hidden="true" size={ICON_SM - 2} />
        </button>
      </div>
      {isDir && expanded && (
        <ul className="workspace-tree__children">
          {directChildren.map((child) => (
            <TreeNodeView
              key={child.path}
              {...treeProps}
              needle={needle}
              matches={matches}
              node={child}
              depth={depth + 1}
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
