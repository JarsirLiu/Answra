import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SurfacePosition {
  x: number;
  y: number;
}

interface SurfaceStateFile {
  position?: SurfacePosition;
}

/** 只持久化浮窗位置；卡片正文、动作和业务数据不落盘。 */
export function createSurfaceStateStore(resolvePath: () => string) {
  function readPosition(): SurfacePosition | undefined {
    try {
      const parsed = JSON.parse(readFileSync(resolvePath(), "utf8")) as SurfaceStateFile;
      const position = parsed.position;
      if (!position || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)) {
        return undefined;
      }
      return position;
    } catch {
      // 文件不存在、JSON 损坏或不可读都回落到默认落位，不阻断浮窗展示。
      return undefined;
    }
  }

  function writePosition(position: SurfacePosition): void {
    if (!Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)) return;
    try {
      const filePath = resolvePath();
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify({ position })}\n`, "utf8");
    } catch (error) {
      console.warn("[surface] failed to persist position", error);
    }
  }

  return { readPosition, writePosition };
}
