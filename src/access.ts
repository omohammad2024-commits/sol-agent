import type { Config } from "./config";
import type { Store } from "./memory/store";
import type { LevelOf } from "./types";

export type AccessAction = "grant" | "ban" | "revoke" | "make_admin";

/** Single implementation of the access hierarchy (used by the admin tool and the web panel). */
export function applyAccess(o: { store: Store; config: Config; levelOf: LevelOf; actorIsOwner: boolean; action: AccessAction; userId: number }) {
  const { store, config, levelOf, actorIsOwner, action, userId } = o;
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("Invalid user id");
  if (config.OWNER_ID && userId === config.OWNER_ID) throw new Error("The creator's access cannot be changed");
  const target = levelOf(userId);
  if ((action === "make_admin" || target === "admin") && !actorIsOwner) throw new Error("Only the creator can manage admins");
  if (action === "grant" && target === "admin") throw new Error("That user is already an admin");
  store.setAcl(userId, action === "grant" ? "trusted" : action === "ban" ? "banned" : action === "make_admin" ? "admin" : null);
  return { user_id: userId, now: levelOf(userId) };
}
