import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../server.js";
import { requireAdminKey } from "../adminAuth.js";
import {
  WALLET_ADDRESS_REGEX,
  createWalletSchema,
  listWalletsQuerySchema,
  updateWalletSchema,
  zodErrorMessage,
} from "../../wallets/validation.js";

function getAddressParam(request: FastifyRequest): string | null {
  const { address } = request.params as { address?: string };
  if (typeof address !== "string" || !WALLET_ADDRESS_REGEX.test(address)) {
    return null;
  }
  return address;
}

export function walletRoutes(ctx: AppContext) {
  return async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
    const adminAuth = requireAdminKey(ctx.adminApiKey);

    app.get("/api/wallets", async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listWalletsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: zodErrorMessage(parsed.error) });
      }
      const { type, tier, enabled } = parsed.data;
      const wallets = await ctx.walletsRepo.list({
        type,
        tier,
        enabled: enabled === undefined ? undefined : enabled === "true",
      });
      return { wallets };
    });

    app.post(
      "/api/wallets",
      { preHandler: adminAuth },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = createWalletSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: zodErrorMessage(parsed.error) });
        }

        const created = await ctx.walletsRepo.create(parsed.data);
        if (!created) {
          return reply.code(409).send({ error: "a wallet with this address already exists" });
        }

        await ctx.watchlistCache.refresh().catch((err: unknown) => {
          ctx.logger.error({ err }, "failed to refresh watchlist cache after create");
        });
        return reply.code(201).send(created);
      },
    );

    app.patch(
      "/api/wallets/:address",
      { preHandler: adminAuth },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const address = getAddressParam(request);
        if (!address) {
          return reply.code(400).send({ error: "address must be a 0x-prefixed 40 hex char address" });
        }

        const parsed = updateWalletSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: zodErrorMessage(parsed.error) });
        }

        const updated = await ctx.walletsRepo.update(address, parsed.data);
        if (!updated) {
          return reply.code(404).send({ error: "wallet not found" });
        }

        await ctx.watchlistCache.refresh().catch((err: unknown) => {
          ctx.logger.error({ err }, "failed to refresh watchlist cache after update");
        });
        return updated;
      },
    );

    app.delete(
      "/api/wallets/:address",
      { preHandler: adminAuth },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const address = getAddressParam(request);
        if (!address) {
          return reply.code(400).send({ error: "address must be a 0x-prefixed 40 hex char address" });
        }

        const removed = await ctx.walletsRepo.remove(address);
        if (!removed) {
          return reply.code(404).send({ error: "wallet not found" });
        }

        await ctx.watchlistCache.refresh().catch((err: unknown) => {
          ctx.logger.error({ err }, "failed to refresh watchlist cache after delete");
        });
        return reply.code(204).send();
      },
    );
  };
}
