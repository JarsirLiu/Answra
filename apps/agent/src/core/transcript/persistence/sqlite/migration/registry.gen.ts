/** 由 `pnpm db:generate` 生成；请勿手工编辑。 */

import { migration as migration0 } from "./migrations/20261121120000_add_session_turns";
import { migration as migration1 } from "./migrations/20261122120000_add_session_events";
import { migration as migration2 } from "./migrations/20261122130000_session_turn_projection";
import { migration as migration3 } from "./migrations/20261123120000_session_items";
import { migration as migration4 } from "./migrations/20261123130000_drop_legacy_session_tables";
import type { Migration } from "./types";

export const MIGRATIONS: readonly Migration[] = [
  migration0,
  migration1,
  migration2,
  migration3,
  migration4,
];
