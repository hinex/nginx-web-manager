import { db } from "~/lib/db/connection";
import { auditLog } from "~/lib/db/schema";

export function logAudit(params: {
  userId: number | null;
  action: "create" | "update" | "delete" | "login" | "logout" | "reload";
  entity: string;
  entityId?: number;
  details?: Record<string, unknown>;
  ipAddress?: string;
}): void {
  db.insert(auditLog)
    .values({
      userId: params.userId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      details: params.details,
      ipAddress: params.ipAddress,
    })
    .run();
}
