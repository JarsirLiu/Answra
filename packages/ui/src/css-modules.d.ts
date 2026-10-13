declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*?url" {
  const url: string;
  export default url;
}

/** 第三方包随包分发的纯 CSS（无类型，Vite 动态 import 注入）。 */
declare module "vditor/dist/index.css";
