import type { WorkspaceNode } from "@answra/shared";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { ICON_SM } from "../../../tokens";
import { classifyFile } from "./fileKind";
import "./DirectoryTree.css";

interface DirectoryTreeProps {
  nodes: WorkspaceNode[];
  selectedPath: string | null;
  onSelect: (node: WorkspaceNode) => void;
  /** 在根目录（V1 固定 parentDir=""）下新建目录或文档。 */
  onCreate: (parentDir: string, kind: "dir" | "file", name: string) => void;
  onDelete: (path: string) => void;
}

interface TreeNodeProps extends DirectoryTreeProps {
  node: WorkspaceNode;
  depth: number;
}

/** 目录树纯展示组件；展开/新建交互在本组件内，数据由 useWorkspace 提供。 */
export function DirectoryTree(props: DirectoryTreeProps) {
  const { nodes } = props;
  const [creating, setCreating] = useState<null | "dir" | "file">(null);

  if (nodes.length === 0)
    return <p className="workspace-tree__empty">目录为空，可在下方新建文档或文件夹。</p>;

  return (
    <div className="workspace-tree">
      <div className="workspace-tree__actions">
        <button
          type="button"
          className="workspace-tree__action"
          title="新建文档"
          onClick={() => setCreating("file")}
        >
          <FilePlus aria-hidden="true" size={ICON_SM} /> 新建文档
        </button>
        <button
          type="button"
          className="workspace-tree__action"
          title="新建文件夹"
          onClick={() => setCreating("dir")}
        >
          <FolderPlus aria-hidden="true" size={ICON_SM} /> 新建文件夹
        </button>
      </div>
      {creating && (
        <NewEntryForm
          kind={creating}
          onCancel={() => setCreating(null)}
          onSubmit={(name) => {
            setCreating(null);
            if (name.trim()) props.onCreate("", creating, name.trim());
          }}
        />
      )}
      <ul className="workspace-tree__list">
        {nodes.map((node) => (
          <TreeNodeView key={node.path} {...props} node={node} depth={0} />
        ))}
      </ul>
    </div>
  );
}

function NewEntryForm({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: "dir" | "file";
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(kind === "file" ? "未命名.md" : "新建文件夹");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(name);
  }
  return (
    <form className="workspace-tree__new" onSubmit={submit}>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={onCancel}
        aria-label={kind === "file" ? "新文档名称" : "新文件夹名称"}
      />
    </form>
  );
}

function TreeNodeView({ node, depth, ...treeProps }: TreeNodeProps) {
  const { selectedPath, onSelect, nodes, onDelete } = treeProps;
  const [expanded, setExpanded] = useState(depth === 0 && node.kind === "dir");
  const isDir = node.kind === "dir";
  const childNodes = isDir ? nodes.filter((child) => child.path.startsWith(`${node.path}/`)) : [];
  const directChildren = childNodes.filter((child) => {
    const rest = child.path.slice(node.path.length + 1);
    return !rest.includes("/");
  });
  const selected = selectedPath === node.path;
  return (
    <li>
      <div
        className={`workspace-tree__row${selected ? " workspace-tree__row--selected" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <button
          type="button"
          className="workspace-tree__item"
          onClick={() => {
            if (isDir) setExpanded((value) => !value);
            else onSelect(node);
          }}
          title={node.path}
        >
          {isDir ? (
            <>
              {expanded ? (
                <ChevronDown aria-hidden="true" size={ICON_SM} />
              ) : (
                <ChevronRight aria-hidden="true" size={ICON_SM} />
              )}
              <Folder aria-hidden="true" size={ICON_SM} />
            </>
          ) : (
            <FileText
              aria-hidden="true"
              size={ICON_SM}
              className={
                classifyFile(node.name) !== "other" ? "workspace-tree__icon-known" : undefined
              }
            />
          )}
          <span>{node.name}</span>
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
        <ul>
          {directChildren.map((child) => (
            <TreeNodeView key={child.path} {...treeProps} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
