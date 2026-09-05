import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Guards write endpoints with the `x-admin-key` header against
 * ADMIN_API_KEY. If ADMIN_API_KEY isn't configured, every request is
 * rejected — a missing key locks the endpoint down rather than leaving it
 * open by accident.
 */
export function requireAdminKey(adminApiKey: string | undefined) {
  return async function adminAuthPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const provided = request.headers["x-admin-key"];
    const ok = !!adminApiKey && typeof provided === "string" && safeEqual(provided, adminApiKey);
    if (!ok) {
      await reply.code(401).send({ error: "unauthorized: missing or invalid x-admin-key header" });
    }
  };
}
