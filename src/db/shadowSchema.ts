// The Shadow Postgres's full schema: V1's tables (re-exported completely
// unchanged, imported once as a read-only historical seed per A.1 — never
// synced back to V1 production) plus V2's new tables. This file is what
// drizzle.shadow.config.ts points at; it is never imported by V1's
// index.ts / db/client.ts, so V1 production is provably unaffected by
// anything V2 does to its own database.
export * from "./schema.js";
export * from "./schemaV2.js";
