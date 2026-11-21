/** 由 `pnpm db:generate` 生成；请勿手工编辑。 */

import { migration as migration0 } from "./migrations/20261121120000_add_session_turns";
import type { Migration } from "./types";

export const MIGRATIONS: readonly Migration[] = [migration0];
