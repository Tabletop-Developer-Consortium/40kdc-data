import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditSourceDigests,
  loadAbilityAnnotations,
  renderSourceDigestAudit,
  type AbilityAnnotation,
  type SourceDigestAuditReport,
} from "../src/audit-source-digest.js";
import {
  parseSourceDigestCorpus,
  sourceDigest,
  sourceIdentityKey,
} from "../src/source-digest.js";

const TOOLS = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TSX = join(TOOLS, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(TOOLS, "src", "audit-source-digest.ts");

/**
 * Fabricated stand-ins for the things that must never leave the audit: a
 * printed rule, an ability's printed name, and a private filesystem path.
 * Nothing here is Games Workshop text.
 */
const FABRICATED_RULE =
  "Fabricated Rule Secret: add 1 to the invented characteristic.";
const FABRICATED_REPRINT =
  "  Fabricated  Rule  Secret:  add 1 to the invented characteristic!  ";
const FABRICATED_REWORD =
  "Fabricated Rule Secret: add 2 to the invented characteristic.";
const FABRICATED_NAME = "Fabricated Ability Name Secret";

const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** A throwaway directory that itself carries a sentinel path fragment. */
function scratch(): string {
  const root = mkdtempSync(
    join(tmpdir(), "audit-source-digest-fabricated-path-fragment-"),
  );
  temporaries.push(root);
  return root;
}

function writeJSON(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Minimal repo-shaped fixture: only the enrichment ability files matter. */
function repoFixture(
  files: Record<string, Record<string, unknown>[]>,
): string {
  const root = scratch();
  for (const [dir, records] of Object.entries(files)) {
    writeJSON(join(root, "data", "enrichment", dir, "abilities.json"), records);
  }
  return root;
}

const annotation = (
  faction_id: string,
  ability_id: string,
  source_digest?: string,
): AbilityAnnotation => ({
  faction_id,
  ability_id,
  ...(source_digest === undefined ? {} : { source_digest }),
});

describe("parseSourceDigestCorpus", () => {
  it("reduces every printed rule to a digest and drops the prose", () => {
    const parsed = parseSourceDigestCorpus({
      necrons: { "fabricated-ability": FABRICATED_RULE },
      _core: { "fabricated-core-ability": FABRICATED_RULE },
    });

    expect([...parsed.keys()]).toEqual([
      "_core/fabricated-core-ability",
      "necrons/fabricated-ability",
    ]);
    expect(parsed.get("necrons/fabricated-ability")).toEqual({
      faction_id: "necrons",
      ability_id: "fabricated-ability",
      digest: sourceDigest(FABRICATED_RULE),
    });
    expect(JSON.stringify([...parsed])).not.toContain("Fabricated Rule Secret");
  });

  it("sorts deterministically regardless of corpus serialisation order", () => {
    const forward = parseSourceDigestCorpus({
      orks: { "zeta-ability": FABRICATED_RULE, "alpha-ability": FABRICATED_RULE },
      aeldari: { "mid-ability": FABRICATED_RULE },
    });
    const reversed = parseSourceDigestCorpus({
      aeldari: { "mid-ability": FABRICATED_RULE },
      orks: { "alpha-ability": FABRICATED_RULE, "zeta-ability": FABRICATED_RULE },
    });

    expect([...forward.keys()]).toEqual([
      "aeldari/mid-ability",
      "orks/alpha-ability",
      "orks/zeta-ability",
    ]);
    expect([...reversed.keys()]).toEqual([...forward.keys()]);
  });

  it("keeps `_core` distinct from a faction with the same ability id", () => {
    const parsed = parseSourceDigestCorpus({
      _core: { "shared-ability": FABRICATED_RULE },
      necrons: { "shared-ability": FABRICATED_REWORD },
    });

    expect(parsed.size).toBe(2);
    expect(parsed.get("_core/shared-ability")?.digest).not.toBe(
      parsed.get("necrons/shared-ability")?.digest,
    );
  });

  const rejected: [string, unknown][] = [
    ["a non-object corpus", "fabricated"],
    ["a null corpus", null],
    ["an array corpus", [{ necrons: {} }]],
    ["a non-object faction level", { necrons: FABRICATED_RULE }],
    ["a null faction level", { necrons: null }],
    ["an array faction level", { necrons: ["fabricated-ability"] }],
    ["an invalid faction key", { "Necron Dynasties": { "a-b": FABRICATED_RULE } }],
    ["a scratch-pool faction key", { "_port-audit": { "a-b": FABRICATED_RULE } }],
    ["an invalid ability key", { necrons: { "Fabricated Ability": FABRICATED_RULE } }],
    ["a non-string value", { necrons: { "fabricated-ability": 7 } }],
    ["a null value", { necrons: { "fabricated-ability": null } }],
    ["an empty value", { necrons: { "fabricated-ability": "" } }],
    ["a punctuation-only value", { necrons: { "fabricated-ability": " ,.  " } }],
  ];

  for (const [label, corpus] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => parseSourceDigestCorpus(corpus)).toThrow();
    });
  }

  it("reports an invalid key by position, never by echoing it", () => {
    // A mis-shaped corpus can put printed rule text in a key, so an invalid
    // key is never echoed; a key that validated as kebab-case safely can be.
    expect(() =>
      parseSourceDigestCorpus({
        aeldari: { "fine-ability": FABRICATED_RULE },
        [FABRICATED_NAME]: { "fine-ability": FABRICATED_RULE },
      }),
    ).toThrow(/faction key #2 is not a valid faction id/);
    expect(() =>
      parseSourceDigestCorpus({
        aeldari: { "fine-ability": FABRICATED_RULE },
        [FABRICATED_NAME]: { "fine-ability": FABRICATED_RULE },
      }),
    ).not.toThrow(/Fabricated Ability Name Secret/);

    expect(() =>
      parseSourceDigestCorpus({
        necrons: {
          "fine-ability": FABRICATED_RULE,
          [FABRICATED_NAME]: FABRICATED_RULE,
        },
      }),
    ).toThrow(/source corpus\["necrons"\]: ability key #2 is not a valid ability id/);
  });

  it("never echoes a rejected source value", () => {
    expect(() =>
      parseSourceDigestCorpus({
        necrons: { "fabricated-ability": ` ${FABRICATED_RULE} ` },
        orks: { "fabricated-ability": "..." },
      }),
    ).toThrow(/source corpus\["orks"\]\["fabricated-ability"\]/);
    expect(() =>
      parseSourceDigestCorpus({ orks: { "fabricated-ability": "..." } }),
    ).not.toThrow(/\.\.\./);
  });
});

describe("loadAbilityAnnotations", () => {
  it("loads live factions and `_core` and skips example/scratch pools", () => {
    const root = repoFixture({
      _core: [{ ability_id: "shared-ability", faction_id: null }],
      necrons: [{ ability_id: "fabricated-ability" }],
      _example: [{ ability_id: "example-ability" }],
      "_port-audit": [{ ability_id: "scratch-ability" }],
    });

    expect(loadAbilityAnnotations(root).map(sourceIdentityKey)).toEqual([
      "_core/shared-ability",
      "necrons/fabricated-ability",
    ]);
  });

  it("keys a record by its authored faction, falling back to its directory", () => {
    const root = repoFixture({
      "adeptus-astartes": [
        { ability_id: "directory-owned" },
        { ability_id: "authored-owned", faction_id: "adeptus-astartes" },
      ],
    });

    expect(loadAbilityAnnotations(root).map(sourceIdentityKey)).toEqual([
      "adeptus-astartes/authored-owned",
      "adeptus-astartes/directory-owned",
    ]);
  });

  it("keeps the same ability id in two factions as two identities", () => {
    const root = repoFixture({
      necrons: [{ ability_id: "shared-ability" }],
      orks: [{ ability_id: "shared-ability" }],
    });

    expect(loadAbilityAnnotations(root).map(sourceIdentityKey)).toEqual([
      "necrons/shared-ability",
      "orks/shared-ability",
    ]);
  });

  it("carries a stored digest through and treats null as absent", () => {
    const digest = sourceDigest(FABRICATED_RULE);
    const root = repoFixture({
      necrons: [
        { ability_id: "tracked-ability", source_digest: digest },
        { ability_id: "null-ability", source_digest: null },
        { ability_id: "absent-ability" },
      ],
    });

    // Sorted by (faction, ability); a null digest is indistinguishable from an
    // absent one, so both classify as `untracked` rather than as a mismatch.
    expect(loadAbilityAnnotations(root)).toEqual([
      annotation("necrons", "absent-ability"),
      annotation("necrons", "null-ability"),
      annotation("necrons", "tracked-ability", digest),
    ]);
  });

  it("rejects a duplicate composite identity rather than picking one", () => {
    const root = repoFixture({
      necrons: [
        { ability_id: "shared-ability" },
        { ability_id: "shared-ability" },
      ],
    });

    expect(() => loadAbilityAnnotations(root)).toThrow(
      /duplicate identity necrons\/shared-ability/,
    );
  });

  it("rejects a duplicate identity produced by an authored faction", () => {
    const root = repoFixture({
      "adeptus-astartes": [{ ability_id: "shared-ability" }],
      "blood-angels": [
        { ability_id: "shared-ability", faction_id: "adeptus-astartes" },
      ],
    });

    expect(() => loadAbilityAnnotations(root)).toThrow(/duplicate identity/);
  });

  const malformed: [string, Record<string, unknown>, RegExp][] = [
    ["a non-array file", { necrons: {} }, /expected a JSON array/],
    ["a non-object record", { necrons: ["fabricated"] }, /is not an object/],
    [
      "a record without an ability_id",
      { necrons: [{ name: FABRICATED_NAME }] },
      /has no ability_id/,
    ],
    [
      "a non-string source_digest",
      { necrons: [{ ability_id: "a-b", source_digest: 7 }] },
      /source_digest must be a string/,
    ],
    [
      "a non-string faction_id",
      { necrons: [{ ability_id: "a-b", faction_id: 7 }] },
      /faction_id must be a string or null/,
    ],
  ];

  for (const [label, records, pattern] of malformed) {
    it(`rejects ${label}`, () => {
      const root = scratch();
      for (const [dir, value] of Object.entries(records)) {
        writeJSON(join(root, "data", "enrichment", dir, "abilities.json"), value);
      }
      expect(() => loadAbilityAnnotations(root)).toThrow(pattern);
    });
  }

  it("rejects a missing enrichment tree", () => {
    expect(() => loadAbilityAnnotations(scratch())).toThrow(
      /data\/enrichment does not exist/,
    );
  });

  it("reports paths relative to the repository root", () => {
    const root = scratch();
    writeJSON(join(root, "data", "enrichment", "necrons", "abilities.json"), {});
    expect(() => loadAbilityAnnotations(root)).toThrow(
      /^data\/enrichment\/necrons\/abilities\.json: /,
    );
    try {
      loadAbilityAnnotations(root);
    } catch (error) {
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).message).not.toContain(
        "audit-source-digest-fabricated-path-fragment",
      );
    }
  });
});

describe("auditSourceDigests", () => {
  it("classifies each of the five outcomes", () => {
    const report = auditSourceDigests(
      {
        necrons: {
          "current-ability": FABRICATED_REPRINT,
          "changed-ability": FABRICATED_REWORD,
          "untracked-ability": FABRICATED_RULE,
        },
        orks: { "unknown-ability": FABRICATED_RULE },
      },
      [
        annotation("necrons", "current-ability", sourceDigest(FABRICATED_RULE)),
        annotation("necrons", "changed-ability", sourceDigest(FABRICATED_RULE)),
        annotation("necrons", "untracked-ability"),
        annotation("necrons", "unsourced-ability", sourceDigest(FABRICATED_RULE)),
      ],
    );

    expect(report.findings).toEqual([
      { faction_id: "necrons", ability_id: "changed-ability", status: "changed" },
      {
        faction_id: "necrons",
        ability_id: "unsourced-ability",
        status: "missing-source",
      },
      {
        faction_id: "necrons",
        ability_id: "untracked-ability",
        status: "untracked",
      },
      { faction_id: "orks", ability_id: "unknown-ability", status: "unknown-source" },
    ]);
    expect(report.summary).toEqual({
      annotations: 4,
      corpus_entries: 4,
      current: 1,
      changed: 1,
      untracked: 1,
      missing_source: 1,
      unknown_source: 1,
      findings: 4,
    });
  });

  it("is clean only when every annotation joined and matched", () => {
    const report = auditSourceDigests(
      {
        _core: { "shared-ability": FABRICATED_RULE },
        necrons: { "fabricated-ability": FABRICATED_REPRINT },
      },
      [
        annotation("_core", "shared-ability", sourceDigest(FABRICATED_RULE)),
        annotation(
          "necrons",
          "fabricated-ability",
          sourceDigest(FABRICATED_RULE),
        ),
      ],
    );

    expect(report.findings).toEqual([]);
    expect(report.summary.current).toBe(2);
    expect(report.summary.findings).toBe(0);
  });

  it("joins faction-scoped rather than by first bare ability id match", () => {
    // The corpus describes the Ork rule only. The Necron annotation with the
    // same bare id must NOT be confirmed by it.
    const report = auditSourceDigests(
      { orks: { "shared-ability": FABRICATED_RULE } },
      [
        annotation("necrons", "shared-ability", sourceDigest(FABRICATED_RULE)),
        annotation("orks", "shared-ability", sourceDigest(FABRICATED_RULE)),
      ],
    );

    expect(report.findings).toEqual([
      {
        faction_id: "necrons",
        ability_id: "shared-ability",
        status: "missing-source",
      },
    ]);
  });

  it("treats a reworded rule as changed and reprint noise as current", () => {
    const stored = sourceDigest(FABRICATED_RULE);
    const reprint = auditSourceDigests(
      { necrons: { "fabricated-ability": FABRICATED_REPRINT } },
      [annotation("necrons", "fabricated-ability", stored)],
    );
    const reword = auditSourceDigests(
      { necrons: { "fabricated-ability": FABRICATED_REWORD } },
      [annotation("necrons", "fabricated-ability", stored)],
    );

    expect(reprint.summary.changed).toBe(0);
    expect(reword.summary.changed).toBe(1);
  });

  it("orders findings by faction, then ability, then status", () => {
    const report = auditSourceDigests(
      {
        orks: { "zeta-ability": FABRICATED_RULE },
        aeldari: {
          "beta-ability": FABRICATED_RULE,
          "alpha-ability": FABRICATED_RULE,
        },
      },
      [
        annotation("orks", "zeta-ability"),
        annotation("aeldari", "beta-ability"),
        annotation("aeldari", "alpha-ability"),
      ],
    );

    expect(report.findings.map(sourceIdentityKey)).toEqual([
      "aeldari/alpha-ability",
      "aeldari/beta-ability",
      "orks/zeta-ability",
    ]);
  });

  it("rejects duplicate annotation identities instead of reporting them", () => {
    expect(() =>
      auditSourceDigests({ necrons: { "a-b": FABRICATED_RULE } }, [
        annotation("necrons", "a-b"),
        annotation("necrons", "a-b"),
      ]),
    ).toThrow(/duplicate identity necrons\/a-b/);
  });

  it("propagates malformed corpus input as an error, not a finding", () => {
    expect(() => auditSourceDigests("fabricated", [])).toThrow(/source corpus/);
  });
});

describe("source-digest audit redaction", () => {
  const sentinels = [
    FABRICATED_RULE,
    FABRICATED_REWORD,
    "Fabricated Rule Secret",
    FABRICATED_NAME,
    sourceDigest(FABRICATED_RULE),
    sourceDigest(FABRICATED_REWORD),
  ];

  function expectRedacted(text: string): void {
    for (const sentinel of sentinels) {
      expect(text).not.toContain(sentinel);
    }
    expect(text).not.toContain("audit-source-digest-fabricated-path-fragment");
  }

  it("retains no prose, name, digest or private path in the report or render", () => {
    const root = repoFixture({
      necrons: [
        { ability_id: "changed-ability", name: FABRICATED_NAME, source_digest: sourceDigest(FABRICATED_RULE) },
        { ability_id: "untracked-ability", name: FABRICATED_NAME },
        { ability_id: "unsourced-ability", name: FABRICATED_NAME },
      ],
    });
    const report = auditSourceDigests(
      {
        necrons: {
          "changed-ability": FABRICATED_REWORD,
          "untracked-ability": FABRICATED_RULE,
        },
        orks: { "unknown-ability": FABRICATED_RULE },
      },
      loadAbilityAnnotations(root),
    );

    expect(report.summary.findings).toBe(4);
    expectRedacted(JSON.stringify(report));
    expectRedacted(renderSourceDigestAudit(report));
  });

  it("renders a stable clean and a stable findings block", () => {
    const clean: SourceDigestAuditReport = auditSourceDigests(
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      [
        annotation(
          "necrons",
          "fabricated-ability",
          sourceDigest(FABRICATED_RULE),
        ),
      ],
    );

    expect(renderSourceDigestAudit(clean)).toBe(
      "source-digest audit — 1 annotations, 1 corpus entries\n" +
        "current 1  changed 0  untracked 0  missing-source 0  unknown-source 0\n" +
        "no findings\n",
    );
    expect(
      renderSourceDigestAudit(
        auditSourceDigests({ necrons: { "fabricated-ability": FABRICATED_RULE } }, [
          annotation("necrons", "fabricated-ability"),
        ]),
      ),
    ).toBe(
      "source-digest audit — 1 annotations, 1 corpus entries\n" +
        "current 0  changed 0  untracked 1  missing-source 0  unknown-source 0\n" +
        "untracked necrons/fabricated-ability\n",
    );
  });
});

describe("audit:source-digest command", () => {
  interface Run {
    status: number | null;
    stdout: string;
    stderr: string;
    /** The private absolute corpus path, so leak assertions can name it. */
    corpusPath: string;
  }

  function run(corpus: unknown, root: string, extra: string[] = []): Run {
    const corpusPath = join(scratch(), "fabricated-corpus-secret.json");
    writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
    const result = spawnSync(
      process.execPath,
      [TSX, SCRIPT, corpusPath, "--root", root, ...extra],
      { encoding: "utf-8", cwd: TOOLS },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      corpusPath,
    };
  }

  const liveRepo = (): string =>
    repoFixture({
      _core: [
        {
          ability_id: "shared-ability",
          faction_id: null,
          source_digest: sourceDigest(FABRICATED_RULE),
        },
      ],
      necrons: [
        {
          ability_id: "fabricated-ability",
          name: FABRICATED_NAME,
          source_digest: sourceDigest(FABRICATED_RULE),
        },
      ],
    });

  const fullCorpus = {
    _core: { "shared-ability": FABRICATED_RULE },
    necrons: { "fabricated-ability": FABRICATED_REPRINT },
  };

  it("exits 0 for a complete, current corpus", () => {
    const result = run(fullCorpus, liveRepo());

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("current 2");
    expect(result.stdout).toContain("no findings");
  });

  it("exits 1 for a changed rule and names only the identity", () => {
    const result = run(
      {
        _core: { "shared-ability": FABRICATED_RULE },
        necrons: { "fabricated-ability": FABRICATED_REWORD },
      },
      liveRepo(),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("changed necrons/fabricated-ability");
    expect(result.stdout).not.toContain("Fabricated Rule Secret");
    expect(result.stdout).not.toContain(FABRICATED_NAME);
    expect(result.stdout).not.toContain(sourceDigest(FABRICATED_RULE));
  });

  it("exits 1 for incomplete coverage in either direction", () => {
    const missing = run({ _core: { "shared-ability": FABRICATED_RULE } }, liveRepo());
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("missing-source necrons/fabricated-ability");

    const unknown = run(
      { ...fullCorpus, orks: { "unknown-ability": FABRICATED_RULE } },
      liveRepo(),
    );
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain("unknown-source orks/unknown-ability");
  });

  it("exits 1 for an untracked annotation", () => {
    const result = run(
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      repoFixture({ necrons: [{ ability_id: "fabricated-ability" }] }),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("untracked necrons/fabricated-ability");
  });

  it("fails nonzero on malformed input without printing a summary", () => {
    const result = run({ necrons: FABRICATED_RULE }, liveRepo());

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('source corpus["necrons"]');
    expect(result.stderr).not.toContain("Fabricated Rule Secret");
  });

  it("accepts the corpus with `--root` omitted or given first", () => {
    const corpusPath = join(scratch(), "fabricated-corpus-secret.json");
    writeFileSync(corpusPath, `${JSON.stringify(fullCorpus, null, 2)}\n`);

    // No `--root`: the audit defaults to this repository. It reports findings
    // (the fabricated corpus does not describe the live annotation set), but it
    // must have parsed the corpus rather than rejected the invocation — a
    // regression guard for `indexOf("--root") === -1` eating argument 0.
    const defaulted = spawnSync(process.execPath, [TSX, SCRIPT, corpusPath], {
      encoding: "utf-8",
      cwd: TOOLS,
    });
    expect(defaulted.stderr).not.toContain("usage:");
    expect(defaulted.stdout).toContain("source-digest audit");

    const flagFirst = spawnSync(
      process.execPath,
      [TSX, SCRIPT, "--root", liveRepo(), corpusPath],
      { encoding: "utf-8", cwd: TOOLS },
    );
    expect(flagFirst.stderr).toBe("");
    expect(flagFirst.status).toBe(0);
    expect(flagFirst.stdout).toContain("no findings");
  });

  it("fails nonzero on a bad invocation", () => {
    const root = liveRepo();
    const noCorpus = spawnSync(process.execPath, [TSX, SCRIPT, "--root", root], {
      encoding: "utf-8",
      cwd: TOOLS,
    });
    expect(noCorpus.status).toBe(1);
    expect(noCorpus.stderr).toContain("usage:");

    const extraArg = run(fullCorpus, root, ["fabricated-extra-argument"]);
    expect(extraArg.status).toBe(1);
    expect(extraArg.stderr).toContain("usage:");
  });

  it("fails nonzero for an unreadable corpus without echoing its path", () => {
    const absent = join(scratch(), "fabricated-absent-corpus-secret.json");
    const result = spawnSync(
      process.execPath,
      [TSX, SCRIPT, absent, "--root", liveRepo()],
      { encoding: "utf-8", cwd: TOOLS },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read the corpus file");
    expect(result.stderr).not.toContain(absent);
    expect(result.stderr).not.toContain("fabricated-absent-corpus-secret");
  });

  it("leaks no prose, digest, name or private path on any stream", () => {
    const root = liveRepo();
    for (const result of [
      run(fullCorpus, root),
      run({ necrons: { "fabricated-ability": FABRICATED_REWORD } }, root),
      run({ necrons: FABRICATED_RULE }, root),
    ]) {
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toContain("Fabricated Rule Secret");
        expect(stream).not.toContain(FABRICATED_NAME);
        expect(stream).not.toContain(sourceDigest(FABRICATED_RULE));
        expect(stream).not.toContain(sourceDigest(FABRICATED_REWORD));
        expect(stream).not.toContain(result.corpusPath);
        expect(stream).not.toContain("fabricated-corpus-secret");
        expect(stream).not.toContain(
          "audit-source-digest-fabricated-path-fragment",
        );
      }
    }
  });
});
