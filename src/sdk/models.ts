import type { RoleConfig, SparraConfig } from "../config.ts";

export type RoleName = keyof SparraConfig["roles"];

export function roleModel(config: SparraConfig, role: RoleName): RoleConfig {
  return config.roles[role];
}
