import { FloatingBarApp } from "@answra/ui";
import { createRoot } from "react-dom/client";
import "@answra/ui/styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("缺少 #root 挂载点");

createRoot(container).render(<FloatingBarApp />);
