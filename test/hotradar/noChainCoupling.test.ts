import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Spec A.2 hard constraint: Scoring / HotCandidate / AlertEngine must
// never import viem or any chain-specific module — chain differences stay
// inside each chain's adapter. This is a static guard against that
// coupling creeping back in, not just a comment.

const HOTRADAR_DIR = join(process.cwd(), "src/hotradar");
const FORBIDDEN_PATTERNS = [/from ["']viem["']/, /chains\/robinhood/, /chains\/solana/, /chains\/bsc/, /chains\/bch/];

describe("hotradar/* — no viem or chain-specific coupling (spec A.2)", () => {
  const files = readdirSync(HOTRADAR_DIR).filter((f) => f.endsWith(".ts"));

  it("found the expected engine files (sanity check the scan isn't vacuous)", () => {
    expect(files).toContain("scoring.ts");
    expect(files).toContain("manager.ts");
    expect(files).toContain("alertEngine.ts");
  });

  it.each(files)("%s does not import viem or a chain-specific adapter module", (file) => {
    const content = readFileSync(join(HOTRADAR_DIR, file), "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });
});
