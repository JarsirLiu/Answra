/** transcript 列宽：由视口测量一次后注入，避免每个 Markdown 块各自订阅终端 resize。 */
import { createContext } from "react";

export const MarkdownColumnsContext = createContext<number | undefined>(undefined);
