import { defineConfig } from "drizzle-kit";

// V2's own drizzle config — separate schema, separate migrations
// directory, separate env var. `drizzle-kit generate` only diffs the
// schema file against ./drizzle-shadow/meta, it never needs a reachable
// database, so SHADOW_DATABASE_URL can be a placeholder for that command;
// `drizzle-kit migrate` does need the real Shadow Postgres URL. Never
// point this at DATABASE_URL (V1 production) — see db/shadowSchema.ts.
const shadowDatabaseUrl = process.env["SHADOW_DATABASE_URL"];
if (!shadowDatabaseUrl) {
  throw new Error("SHADOW_DATABASE_URL is required to run drizzle-kit against the V2 shadow schema");
}

export default defineConfig({
  // Two files directly (not shadowSchema.ts's re-export) — drizzle-kit
  // loads schema files via a CJS+esbuild-register require chain that
  // can't resolve this ESM project's ".js"-suffixed relative imports
  // (e.g. `export * from "./schema.js"`), so schemaV2.ts's own relative
  // imports are fine but a re-export barrel between two schema files
  // isn't. shadowSchema.ts still exists for the app's own ESM runtime
  // (shadowClient.ts) where Node's real ESM resolver handles it correctly.
  schema: ["./src/db/schema.ts", "./src/db/schemaV2.ts"],
  out: "./drizzle-shadow",
  dialect: "postgresql",
  dbCredentials: {
    url: shadowDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
