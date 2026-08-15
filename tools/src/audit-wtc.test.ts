import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { auditWtcCorpus, diffValues } from "./audit-wtc.js";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function corpusWithFabricatedSecrets(): string {
  const root = mkdtempSync(join(tmpdir(), "audit-wtc-visible-directory-"));
  fixtures.push(root);
  const lists = join(root, "lists", "fabricated-path-fragment");
  mkdirSync(lists, { recursive: true });
  writeFileSync(
    join(lists, "fabricated-roster-secret.txt"),
    `Fictional Faction - Fabricated Roster Secret - [1000 pts]

# ++ Army Roster ++ [1000 pts]
## Configuration
Battle Size: Incursion (1000 Point limit)
Detachment: MixedCase! Detachment Secret

## Battleline [100 pts]
Unresolved Unit Secret [100 pts]: Unresolved Wargear Secret
`,
  );
  return root;
}

describe("auditWtcCorpus privacy", () => {
  it("persists only structural diagnostics and opaque row ordinals", () => {
    const report = auditWtcCorpus(corpusWithFabricatedSecrets());
    const serialized = JSON.stringify(report);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.ordinal).toBe(0);
    expect(report.rows[0]?.unresolved_refs).toContainEqual({ kind: "faction" });
    expect(report.rows[0]?.parse_warnings.map((warning) => warning.code)).toContain("faction-unresolved");
    expect(report.summary.unresolved_refs).toBeGreaterThan(0);
    expect(report.summary.warning_failures).toBeGreaterThan(0);
    expect(serialized).not.toContain("audit-wtc-visible-directory");
    expect(serialized).not.toContain("fabricated-path-fragment");
    expect(serialized).not.toContain("fabricated-roster-secret");
    expect(serialized).not.toContain("Fabricated Roster Secret");
    expect(serialized).not.toContain("MixedCase! Detachment Secret");
    expect(serialized).not.toContain("Unresolved Unit Secret");
    expect(serialized).not.toContain("Unresolved Wargear Secret");
    expect(serialized).not.toContain("corpus_root");
    expect(serialized).not.toContain("raw_name");
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("detail");
  });

  it("records a byte-exact ordered detachment raw-name mismatch without either value", () => {
    const differences = diffValues(
      { detachments: [{ id: "fictional-detachment", raw_name: "MixedCase! Detachment" }] },
      { detachments: [{ id: "fictional-detachment", raw_name: "mixedcase! detachment" }] },
    );

    expect(differences).toEqual([{ path: "$.detachments[0].raw_name", kind: "value-mismatch" }]);
    expect(JSON.stringify(differences)).not.toContain("MixedCase! Detachment");
    expect(JSON.stringify(differences)).not.toContain("mixedcase! detachment");
  });
});
