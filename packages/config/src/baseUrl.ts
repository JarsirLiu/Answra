/**
 * 端点地址归一：只接受 http(s)，去掉末尾斜杠，拒绝内嵌账号密码。
 *
 * `label` 只影响错误文案，便于不同配置段指向正确的字段。
 */
export function normalizeBaseUrl(value: string, label = "本地模型地址"): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}不是合法 URL。`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label}只支持 http(s)。`);
  }
  if (url.username || url.password) {
    throw new Error(`${label}不能包含账号密码。`);
  }
  return raw.replace(/\/+$/, "");
}
