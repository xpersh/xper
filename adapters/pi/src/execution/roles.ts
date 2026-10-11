import { capabilitiesForRole } from "@xper/adapter-shared";
import type { RoleCapability } from "@xper/adapter-shared";

const nativeTools: Record<RoleCapability, string[]> = {
  read: ["read"],
  command: ["bash"],
  modify: ["edit", "write"],
};

export function toolsForRole(role: string): string[] {
  return capabilitiesForRole(role).flatMap((capability) => nativeTools[capability]);
}
