import { z } from "zod";

export const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export const walletTypeSchema = z.enum(["KOL", "FOMO_TRADER", "SMART_MONEY"]);
export const walletTierSchema = z.enum(["A", "B", "C"]);

const walletAddressSchema = z
  .string()
  .regex(WALLET_ADDRESS_REGEX, "address must be a 0x-prefixed 40 hex char address");

export const createWalletSchema = z.object({
  address: walletAddressSchema,
  name: z.string().min(1, "name is required"),
  type: walletTypeSchema,
  tier: walletTierSchema,
  ownerGroup: z.string().min(1, "ownerGroup is required"),
  enabled: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export const updateWalletSchema = z.object({
  name: z.string().min(1).optional(),
  type: walletTypeSchema.optional(),
  tier: walletTierSchema.optional(),
  ownerGroup: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

export const listWalletsQuerySchema = z.object({
  type: walletTypeSchema.optional(),
  tier: walletTierSchema.optional(),
  enabled: z.enum(["true", "false"]).optional(),
});

export function zodErrorMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
