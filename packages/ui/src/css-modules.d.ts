declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*?url" {
  const url: string;
  export default url;
}
