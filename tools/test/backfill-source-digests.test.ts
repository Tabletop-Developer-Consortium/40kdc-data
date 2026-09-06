import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditSourceDigests,
  loadAbilityAnnotationFiles,
  loadAbilityAnnotations,
} from "../src/audit-source-digest.js";
import {
  planSourceDigestBackfill,
  parseBackfillArgs,
  projectSourceDigestText,
  renderSourceDigestBackfill,
  scanAbilityRecordSpans,
  writeSourceDigestBackfill,
} from "../src/backfill-source-digests.js";
import { sourceDigest } from "../src/source-digest.js";

const TOOLS = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TSX = join(TOOLS, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(TOOLS, "src", "backfill-source-digests.ts");

/**
 * Fabricated stand-ins for the things that must never leave the command: a
 * printed rule, an ability's printed name, and a private filesystem path.
 * Nothing here is Games Workshop text.
 */
const FABRICATED_RULE =
  "Fabricated Rule Secret: add 1 to the invented characteristic.";
const FABRICATED_REPRINT =
  "  Fabricated  Rule  Secret:  add 1 to the invented characteristic!  ";
const FABRICATED_REWORD =
  "Fabricated Rule Secret: add 2 to the invented characteristic.";
const FABRICATED_OTHER_RULE =
  "Fabricated Other Rule Secret: subtract 1 from the invented characteristic.";
const FABRICATED_NAME = "Fabricated Ability Name Secret";

const DIGEST = sourceDigest(FABRICATED_RULE);
const REWORD_DIGEST = sourceDigest(FABRICATED_REWORD);
const OTHER_DIGEST = sourceDigest(FABRICATED_OTHER_RULE);
/** A syntactically valid digest that no fabricated rule produces. */
const STALE_DIGEST = "0".repeat(64);

const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** A throwaway directory that itself carries a sentinel path fragment. */
function scratch(): string {
  const root = mkdtempSync(
    join(tmpdir(), "backfill-source-digest-fabricated-path-fragment-"),
  );
  temporaries.push(root);
  return root;
}

function writeJSON(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Minimal repo-shaped fixture: only the enrichment ability files matter. */
function repoFixture(files: Record<string, unknown>): string {
  const root = scratch();
  for (const [dir, records] of Object.entries(files)) {
    writeJSON(join(root, "data", "enrichment", dir, "abilities.json"), records);
  }
  return root;
}

function abilityFile(root: string, dir: string): string {
  return join(root, "data", "enrichment", dir, "abilities.json");
}

function readAbilities(root: string, dir: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(abilityFile(root, dir), "utf-8")) as Record<
    string,
    unknown
  >[];
}

function readRaw(root: string, dir: string): string {
  return readFileSync(abilityFile(root, dir), "utf-8");
}

/**
 * A record shaped like a real annotation: `game_version` present (the schema
 * requires it and it is the key `source_digest` anchors after), plus mechanics
 * and metadata that must survive untouched.
 */
function record(
  ability_id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ability_id,
    name: FABRICATED_NAME,
    authored_by: "community",
    game_version: { edition: "11th", dataslate: "2025-q3" },
    version: "2025-q3",
    effect: { type: "modify-characteristic", characteristic: "strength", value: 1 },
    scope: { range: "self", duration: "phase" },
    unit_ids: ["fabricated-unit"],
    ability_type: "unit",
    behavior: "passive",
    ...extra,
  };
}

/** Run the plan-then-write path the CLI runs, against a fixture root. */
function backfill(
  corpus: unknown,
  root: string,
): ReturnType<typeof planSourceDigestBackfill> {
  const plan = planSourceDigestBackfill(
    corpus,
    loadAbilityAnnotationFiles(root),
  );
  writeSourceDigestBackfill(plan);
  return plan;
}

/**
 * Split `before`/`after` into the lines `after` adds and the lines it drops.
 *
 * The writer's contract is that `after` is `before` with whole lines inserted
 * (plus in-place value rewrites), so every line of `before` must still appear,
 * in order. `removed` is whatever of `before` this forward walk could not
 * account for.
 */
function lineDelta(
  before: string,
  after: string,
): { added: string[]; removed: string[] } {
  const originals = before.split("\n");
  const added: string[] = [];
  let cursor = 0;
  for (const line of after.split("\n")) {
    if (cursor < originals.length && originals[cursor] === line) {
      cursor += 1;
      continue;
    }
    added.push(line);
  }
  return { added, removed: originals.slice(cursor) };
}

const DIGEST_LINE = /^\s*"source_digest": "[0-9a-f]{64}",?$/;

/**
 * The contract the coordinator asked to be pinned: the only difference between
 * the original and written text is added `source_digest` lines, and nothing is
 * removed.
 */
function expectDigestOnlyInsertions(
  before: string,
  after: string,
  count: number,
): void {
  const { added, removed } = lineDelta(before, after);
  expect(removed).toEqual([]);
  expect(added).toHaveLength(count);
  for (const line of added) expect(line).toMatch(DIGEST_LINE);
}

describe("projectSourceDigestText", () => {
  /**
   * Both real escape conventions found in `data/enrichment/*`: one faction file
   * writes typographic punctuation as `\uXXXX` escapes, another writes the
   * literal UTF-8. No serialiser round-trips both, so the writer must not
   * serialise at all.
   */
  const LITERAL_FILE = `[
  {
    "ability_id": "fabricated-literal",
    "name": "Fabricated’s Blessing — Literal",
    "authored_by": "community",
    "game_version": {
      "edition": "11th",
      "dataslate": "2025-q3"
    },
    "version": "2025-q3",
    "community_notes": "fabricated note — with an em dash",
    "effect": { "type": "deep-strike", "target": "self" },
    "scope": { "range": "self", "duration": "phase" }
  }
]
`;

  const ESCAPED_FILE = `[
  {
    "ability_id": "fabricated-escaped",
    "name": "Fabricated\\u2019s Blessing \\u2014 Escaped",
    "authored_by": "community",
    "game_version": {
      "edition": "11th",
      "dataslate": "2025-q3"
    },
    "version": "2025-q3",
    "community_notes": "fabricated note \\u2014 with an em dash",
    "effect": { "type": "deep-strike", "target": "self" },
    "scope": { "range": "self", "duration": "phase" }
  }
]
`;

  it("scans a record's members without being fooled by strings", () => {
    // A value containing `"game_version": {` and braces must not be mistaken
    // for structure.
    const text = `[
  {
    "ability_id": "a-b",
    "name": "a \\" quote, a {brace} and \\"game_version\\": { text",
    "game_version": { "edition": "11th", "dataslate": "2025-q3" }
  }
]
`;
    const [span] = scanAbilityRecordSpans(text);
    expect(span.members.map((m) => m.key)).toEqual([
      "ability_id",
      "name",
      "game_version",
    ]);
    expect(JSON.parse(text.slice(span.start, span.end))).toEqual(
      JSON.parse(text)[0],
    );
  });

  it("scans an empty array and an empty record", () => {
    expect(scanAbilityRecordSpans("[]\n")).toEqual([]);
    expect(scanAbilityRecordSpans("[\n  {}\n]\n")[0].members).toEqual([]);
  });

  for (const [style, text] of [
    ["literal UTF-8", LITERAL_FILE],
    ["\\uXXXX-escaped", ESCAPED_FILE],
  ] as const) {
    it(`inserts into a ${style} file without touching any other byte`, () => {
      const after = projectSourceDigestText(
        text,
        1,
        new Map([[0, DIGEST]]),
      );

      expectDigestOnlyInsertions(text, after, 1);
      // The digest sits in the schema's property position…
      expect(after).toContain(
        `    },\n    "source_digest": "${DIGEST}",\n    "version": "2025-q3",`,
      );
      // …and the record still parses to the original plus one field.
      expect(JSON.parse(after)[0]).toEqual({
        ...JSON.parse(text)[0],
        source_digest: DIGEST,
      });
      // Removing the inserted line recovers the file byte for byte.
      expect(
        after
          .split("\n")
          .filter((line) => !DIGEST_LINE.test(line))
          .join("\n"),
      ).toBe(text);
    });

    it(`replaces a digest in a ${style} file without touching any other byte`, () => {
      const stale = text.replace(
        '    "version": "2025-q3",',
        `    "source_digest": "${STALE_DIGEST}",\n    "version": "2025-q3",`,
      );
      const after = projectSourceDigestText(stale, 1, new Map([[0, DIGEST]]));

      // A replacement changes one value in place: one line differs, and the key
      // has not moved.
      expect(after).toBe(stale.replace(STALE_DIGEST, DIGEST));
      expect(Object.keys(JSON.parse(after)[0])).toEqual(
        Object.keys(JSON.parse(stale)[0]),
      );
    });
  }

  it("does not re-encode the other convention's escapes", () => {
    // The regression: `JSON.stringify` would emit `’` for `’` (and vice
    // versa for an ASCII-escaping serialiser), rewriting names and notes.
    const escaped = projectSourceDigestText(ESCAPED_FILE, 1, new Map([[0, DIGEST]]));
    expect(escaped).toContain('\\u2019s Blessing \\u2014 Escaped');
    expect(escaped).not.toContain("’s Blessing");

    const literal = projectSourceDigestText(LITERAL_FILE, 1, new Map([[0, DIGEST]]));
    expect(literal).toContain("’s Blessing — Literal");
    expect(literal).not.toContain("\\u2019");
  });

  it("returns the text unchanged when there is nothing to write", () => {
    expect(projectSourceDigestText(LITERAL_FILE, 1, new Map())).toBe(
      LITERAL_FILE,
    );
  });

  it("replaces an explicit null in place", () => {
    const text = LITERAL_FILE.replace(
      '    "version": "2025-q3",',
      '    "source_digest": null,\n    "version": "2025-q3",',
    );
    const after = projectSourceDigestText(text, 1, new Map([[0, DIGEST]]));

    expect(after).toBe(text.replace("null", `"${DIGEST}"`));
    expect(JSON.parse(after)[0].source_digest).toBe(DIGEST);
  });

  it("appends after the last member when the anchor key is absent", () => {
    const text = '[\n  {\n    "ability_id": "a-b",\n    "name": "n"\n  }\n]\n';
    const after = projectSourceDigestText(text, 1, new Map([[0, DIGEST]]));

    expect(after).toBe(
      `[\n  {\n    "ability_id": "a-b",\n    "name": "n",\n    "source_digest": "${DIGEST}"\n  }\n]\n`,
    );
  });

  it("inserts into a packed record inline rather than splitting other lines", () => {
    // No repository file is written this way, but a hand-edited one might be:
    // the field still lands after `game_version` and stays valid JSON.
    const text =
      '[\n  { "ability_id": "a-b", "game_version": { "edition": "11th" }, "version": "v" }\n]\n';
    const after = projectSourceDigestText(text, 1, new Map([[0, DIGEST]]));

    expect(JSON.parse(after)[0]).toEqual({
      ...JSON.parse(text)[0],
      source_digest: DIGEST,
    });
    expect(Object.keys(JSON.parse(after)[0])).toEqual([
      "ability_id",
      "game_version",
      "source_digest",
      "version",
    ]);
  });

  it("edits several records in one file independently", () => {
    const records = [0, 1, 2].map((i) => record(`fabricated-ability-${i}`));
    const text = `${JSON.stringify(records, null, 2)}\n`;
    const after = projectSourceDigestText(
      text,
      3,
      new Map([
        [0, DIGEST],
        [2, OTHER_DIGEST],
      ]),
    );

    expectDigestOnlyInsertions(text, after, 2);
    const parsed = JSON.parse(after);
    expect(parsed[0].source_digest).toBe(DIGEST);
    expect(parsed[1]).not.toHaveProperty("source_digest");
    expect(parsed[2].source_digest).toBe(OTHER_DIGEST);
  });

  it("refuses a record count that disagrees with parsing", () => {
    // A scanner/parser disagreement would let a digest land on the wrong
    // record, so it is not recoverable.
    expect(() =>
      projectSourceDigestText(LITERAL_FILE, 2, new Map([[0, DIGEST]])),
    ).toThrow(/found 1 records where parsing found 2/);
    expect(() =>
      projectSourceDigestText(LITERAL_FILE, 1, new Map([[5, DIGEST]])),
    ).toThrow(/record #6 is not present in the text/);
  });
});

describe("planSourceDigestBackfill", () => {
  it("projects adds, replacements and unchanged records with safe counts", () => {
    const root = repoFixture({
      _core: [record("shared-ability", { faction_id: null })],
      necrons: [
        record("added-ability"),
        record("replaced-ability", { source_digest: STALE_DIGEST }),
        record("current-ability", { source_digest: DIGEST }),
      ],
    });

    const plan = planSourceDigestBackfill(
      {
        _core: { "shared-ability": FABRICATED_OTHER_RULE },
        necrons: {
          "added-ability": FABRICATED_RULE,
          "replaced-ability": FABRICATED_REWORD,
          "current-ability": FABRICATED_REPRINT,
        },
      },
      loadAbilityAnnotationFiles(root),
    );

    expect(plan.report.summary).toEqual({
      annotations: 4,
      corpus_entries: 4,
      files_scanned: 2,
      files_changed: 2,
      unchanged: 1,
      skipped: 0,
      added: 2,
      replaced: 1,
    });
    expect(plan.report.files).toEqual([
      { file: "data/enrichment/_core/abilities.json", added: 1, replaced: 0 },
      { file: "data/enrichment/necrons/abilities.json", added: 1, replaced: 1 },
    ]);
  });

  it("stages nothing when every stored digest already matches", () => {
    const root = repoFixture({
      necrons: [record("fabricated-ability", { source_digest: DIGEST })],
    });

    const plan = planSourceDigestBackfill(
      { necrons: { "fabricated-ability": FABRICATED_REPRINT } },
      loadAbilityAnnotationFiles(root),
    );

    expect(plan.writes).toEqual([]);
    expect(plan.report.files).toEqual([]);
    expect(plan.report.summary.unchanged).toBe(1);
  });

  it("orders changed files and staged writes by relative path", () => {
    const root = repoFixture({
      orks: [record("ork-ability")],
      aeldari: [record("aeldari-ability")],
      _core: [record("shared-ability")],
    });

    const plan = planSourceDigestBackfill(
      {
        orks: { "ork-ability": FABRICATED_RULE },
        aeldari: { "aeldari-ability": FABRICATED_RULE },
        _core: { "shared-ability": FABRICATED_RULE },
      },
      loadAbilityAnnotationFiles(root),
    );

    expect(plan.report.files.map((file) => file.file)).toEqual([
      "data/enrichment/_core/abilities.json",
      "data/enrichment/aeldari/abilities.json",
      "data/enrichment/orks/abilities.json",
    ]);
    expect(plan.writes.map((write) => write.relative)).toEqual(
      plan.report.files.map((file) => file.file),
    );
  });

  it("preserves the file's original text apart from the inserted digests", () => {
    const root = repoFixture({ necrons: [record("fabricated-ability")] });
    const before = readRaw(root, "necrons");
    const plan = planSourceDigestBackfill(
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      loadAbilityAnnotationFiles(root),
    );

    const contents = plan.writes[0].contents;
    expectDigestOnlyInsertions(before, contents, 1);
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.endsWith("\n\n")).toBe(false);
  });

  it("preserves both JSON escape conventions found in the live tree", () => {
    // The regression the real run hit: re-serialising rewrote 103 `name` and 6
    // `community_notes` values, because the committed files disagree about
    // whether typographic punctuation is escaped. Neither half may churn.
    const root = scratch();
    const literal = `[
  {
    "ability_id": "fabricated-literal",
    "name": "Fabricated’s Blessing — Literal",
    "authored_by": "community",
    "game_version": { "edition": "11th", "dataslate": "2025-q3" },
    "community_notes": "fabricated note — literal",
    "effect": { "type": "deep-strike", "target": "self" },
    "scope": { "range": "self", "duration": "phase" }
  }
]
`;
    const escaped = `[
  {
    "ability_id": "fabricated-escaped",
    "name": "Fabricated\\u2019s Blessing \\u2014 Escaped",
    "authored_by": "community",
    "game_version": { "edition": "11th", "dataslate": "2025-q3" },
    "community_notes": "fabricated note \\u2014 escaped",
    "effect": { "type": "deep-strike", "target": "self" },
    "scope": { "range": "self", "duration": "phase" }
  }
]
`;
    mkdirSync(join(root, "data", "enrichment", "orks"), { recursive: true });
    mkdirSync(join(root, "data", "enrichment", "blood-angels"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "data", "enrichment", "orks", "abilities.json"),
      literal,
    );
    writeFileSync(
      join(root, "data", "enrichment", "blood-angels", "abilities.json"),
      escaped,
    );

    backfill(
      {
        orks: { "fabricated-literal": FABRICATED_RULE },
        "blood-angels": { "fabricated-escaped": FABRICATED_OTHER_RULE },
      },
      root,
    );

    const afterLiteral = readRaw(root, "orks");
    const afterEscaped = readRaw(root, "blood-angels");
    expectDigestOnlyInsertions(literal, afterLiteral, 1);
    expectDigestOnlyInsertions(escaped, afterEscaped, 1);
    // Each file kept its own convention.
    expect(afterLiteral).toContain("’s Blessing — Literal");
    expect(afterLiteral).not.toContain("\\u2019");
    expect(afterEscaped).toContain("\\u2019s Blessing \\u2014 Escaped");
    expect(afterEscaped).not.toContain("’s Blessing");
  });

  it("replaces an existing digest in a file of either convention", () => {
    const root = scratch();
    const withDigest = (name: string): string => `[
  {
    "ability_id": "fabricated-ability",
    "name": ${name},
    "authored_by": "community",
    "game_version": { "edition": "11th", "dataslate": "2025-q3" },
    "source_digest": "${STALE_DIGEST}",
    "effect": { "type": "deep-strike", "target": "self" },
    "scope": { "range": "self", "duration": "phase" }
  }
]
`;
    const literal = withDigest('"Fabricated’s Blessing — Literal"');
    const escaped = withDigest('"Fabricated\\u2019s Blessing \\u2014 Escaped"');
    for (const [dir, text] of [
      ["orks", literal],
      ["blood-angels", escaped],
    ] as const) {
      mkdirSync(join(root, "data", "enrichment", dir), { recursive: true });
      writeFileSync(
        join(root, "data", "enrichment", dir, "abilities.json"),
        text,
      );
    }

    const plan = backfill(
      {
        orks: { "fabricated-ability": FABRICATED_RULE },
        "blood-angels": { "fabricated-ability": FABRICATED_RULE },
      },
      root,
    );

    expect(plan.report.summary).toMatchObject({ added: 0, replaced: 2 });
    // A replacement is one changed value: nothing else in either file moved.
    expect(readRaw(root, "orks")).toBe(literal.replace(STALE_DIGEST, DIGEST));
    expect(readRaw(root, "blood-angels")).toBe(
      escaped.replace(STALE_DIGEST, DIGEST),
    );
  });

  it("joins faction-scoped rather than by first bare ability id match", () => {
    // Same bare ability id in two factions, with different printed rules. Each
    // annotation must receive its own faction's digest.
    const root = repoFixture({
      necrons: [record("shared-ability")],
      orks: [record("shared-ability")],
    });

    backfill(
      {
        necrons: { "shared-ability": FABRICATED_RULE },
        orks: { "shared-ability": FABRICATED_OTHER_RULE },
      },
      root,
    );

    expect(readAbilities(root, "necrons")[0].source_digest).toBe(DIGEST);
    expect(readAbilities(root, "orks")[0].source_digest).toBe(OTHER_DIGEST);
  });

  it("keys a record by its authored faction, not its directory", () => {
    // A Blood Angels file can hold a record authored to adeptus-astartes; the
    // corpus must be able to address it by the identity the runtime resolves.
    const root = repoFixture({
      "blood-angels": [
        record("authored-ability", { faction_id: "adeptus-astartes" }),
      ],
    });

    backfill(
      { "adeptus-astartes": { "authored-ability": FABRICATED_RULE } },
      root,
    );

    expect(readAbilities(root, "blood-angels")[0].source_digest).toBe(DIGEST);
  });

  it("ignores example and scratch pools rather than demanding corpus entries", () => {
    const root = repoFixture({
      necrons: [record("fabricated-ability")],
      _example: [record("example-ability")],
      "_port-audit": [record("scratch-ability")],
    });

    const plan = backfill(
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      root,
    );

    expect(plan.report.summary.files_scanned).toBe(1);
    expect(readAbilities(root, "_example")[0]).not.toHaveProperty(
      "source_digest",
    );
    expect(readAbilities(root, "_port-audit")[0]).not.toHaveProperty(
      "source_digest",
    );
  });
});

describe("source-digest backfill atomicity", () => {
  /** Snapshot every enrichment file's exact bytes. */
  function snapshot(root: string): Record<string, string> {
    const enrichment = join(root, "data", "enrichment");
    return Object.fromEntries(
      readdirSync(enrichment).map((dir) => [dir, readRaw(root, dir)]),
    );
  }

  const populated = (): string =>
    repoFixture({
      _core: [record("shared-ability", { faction_id: null })],
      necrons: [record("first-ability"), record("second-ability")],
      orks: [record("ork-ability")],
    });

  const fullCorpus = {
    _core: { "shared-ability": FABRICATED_RULE },
    necrons: {
      "first-ability": FABRICATED_RULE,
      "second-ability": FABRICATED_OTHER_RULE,
    },
    orks: { "ork-ability": FABRICATED_RULE },
  };

  const aborts: [string, () => unknown][] = [
    ["a malformed corpus", () => "fabricated"],
    ["a non-object faction level", () => ({ necrons: FABRICATED_RULE })],
    [
      "an invalid corpus value",
      () => ({ ...fullCorpus, orks: { "ork-ability": 7 } }),
    ],
    [
      "a corpus value that normalises to nothing",
      () => ({ ...fullCorpus, orks: { "ork-ability": " ,. " } }),
    ],
    [
      "an annotation with no corpus entry",
      () => ({ ...fullCorpus, necrons: { "first-ability": FABRICATED_RULE } }),
    ],
    [
      "a corpus entry with no annotation",
      () => ({ ...fullCorpus, tyranids: { "unknown-ability": FABRICATED_RULE } }),
    ],
    [
      "a bare-id corpus entry under the wrong faction",
      () => ({
        ...fullCorpus,
        orks: {},
        necrons: { ...fullCorpus.necrons, "ork-ability": FABRICATED_RULE },
      }),
    ],
  ];

  for (const [label, corpus] of aborts) {
    it(`writes nothing for ${label}`, () => {
      const root = populated();
      const before = snapshot(root);

      expect(() =>
        planSourceDigestBackfill(corpus(), loadAbilityAnnotationFiles(root)),
      ).toThrow();
      // The projection never touched the filesystem, so the abort cannot have
      // left a partially-digested tree behind.
      expect(snapshot(root)).toEqual(before);
    });
  }

  it("writes nothing for a malformed ability file", () => {
    const root = populated();
    writeJSON(abilityFile(root, "orks"), { "not-an": "array" });
    const before = snapshot(root);

    expect(() => loadAbilityAnnotationFiles(root)).toThrow(
      /data\/enrichment\/orks\/abilities\.json: expected a JSON array/,
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("writes nothing for a duplicate public composite identity", () => {
    const root = populated();
    writeJSON(abilityFile(root, "orks"), [
      record("ork-ability"),
      record("ork-ability"),
    ]);
    const before = snapshot(root);

    expect(() => loadAbilityAnnotationFiles(root)).toThrow(
      /duplicate identity orks\/ork-ability/,
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("rejects an identity list that is not aligned with its records", () => {
    const root = repoFixture({
      necrons: [record("first-ability"), record("second-ability")],
    });
    const [file] = loadAbilityAnnotationFiles(root);

    expect(() =>
      planSourceDigestBackfill(
        { necrons: { "first-ability": FABRICATED_RULE } },
        [{ ...file, annotations: file.annotations.slice(0, 1) }],
      ),
    ).toThrow(
      /data\/enrichment\/necrons\/abilities\.json: 1 identities for 2 records/,
    );
  });

  it("rejects a duplicate identity handed straight to the projection", () => {
    const root = repoFixture({ necrons: [record("fabricated-ability")] });
    const files = loadAbilityAnnotationFiles(root);
    // Duplicate the loaded file so the same identity is claimed twice; the write
    // path must refuse rather than pick one.
    expect(() =>
      planSourceDigestBackfill(
        { necrons: { "fabricated-ability": FABRICATED_RULE } },
        [...files, ...files],
      ),
    ).toThrow(/duplicate identity necrons\/fabricated-ability/);
  });

  it("leaves an already-current file byte-identical and rewrites only the rest", () => {
    const root = populated();
    // Make `orks` already current, so it must not be rewritten at all — not
    // even re-serialised to identical bytes, since that would still churn mtimes
    // and any formatting the file happened to carry.
    writeJSON(abilityFile(root, "orks"), [
      record("ork-ability", { source_digest: DIGEST }),
    ]);
    const before = snapshot(root);

    const plan = backfill(fullCorpus, root);

    expect(plan.report.files.map((file) => file.file)).toEqual([
      "data/enrichment/_core/abilities.json",
      "data/enrichment/necrons/abilities.json",
    ]);
    expect(readRaw(root, "orks")).toBe(before.orks);
    expect(readRaw(root, "necrons")).not.toBe(before.necrons);
  });
});

describe("source-digest backfill mutation scope", () => {
  it("changes only source_digest, leaving every other field and the order", () => {
    const root = repoFixture({
      necrons: [
        record("first-ability", { community_notes: "fabricated authored note" }),
        record("second-ability", { source_digest: STALE_DIGEST }),
        record("third-ability", { supersedes: null, detachment_id: null }),
      ],
    });
    const before = readAbilities(root, "necrons");

    backfill(
      {
        necrons: {
          "first-ability": FABRICATED_RULE,
          "second-ability": FABRICATED_REWORD,
          "third-ability": FABRICATED_OTHER_RULE,
        },
      },
      root,
    );
    const after = readAbilities(root, "necrons");

    // Entry order is preserved, and stripping the digest recovers the input
    // exactly — mechanics, links, metadata and names cannot have moved.
    expect(after.map((entry) => entry.ability_id)).toEqual(
      before.map((entry) => entry.ability_id),
    );
    const strip = (
      entries: Record<string, unknown>[],
    ): Record<string, unknown>[] =>
      entries.map(({ source_digest: _ignored, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
    expect(after.map((entry) => entry.source_digest)).toEqual([
      DIGEST,
      REWORD_DIGEST,
      OTHER_DIGEST,
    ]);
  });

  it("is idempotent — a second run stages no writes and changes no bytes", () => {
    const root = repoFixture({
      _core: [record("shared-ability", { faction_id: null })],
      necrons: [record("fabricated-ability", { source_digest: STALE_DIGEST })],
    });
    const corpus = {
      _core: { "shared-ability": FABRICATED_OTHER_RULE },
      necrons: { "fabricated-ability": FABRICATED_RULE },
    };

    const first = backfill(corpus, root);
    expect(first.report.summary.files_changed).toBe(2);
    const afterFirst = {
      _core: readRaw(root, "_core"),
      necrons: readRaw(root, "necrons"),
    };

    const second = backfill(corpus, root);
    expect(second.writes).toEqual([]);
    expect(second.report.summary).toMatchObject({
      files_changed: 0,
      added: 0,
      replaced: 0,
      unchanged: 2,
    });
    expect(readRaw(root, "_core")).toBe(afterFirst._core);
    expect(readRaw(root, "necrons")).toBe(afterFirst.necrons);
  });

  it("leaves the strict audit clean against the same corpus", () => {
    const root = repoFixture({
      _core: [record("shared-ability", { faction_id: null })],
      necrons: [record("fabricated-ability"), record("other-ability")],
    });
    const corpus = {
      _core: { "shared-ability": FABRICATED_OTHER_RULE },
      necrons: {
        "fabricated-ability": FABRICATED_RULE,
        "other-ability": FABRICATED_REWORD,
      },
    };

    // Before: nothing is fingerprinted, so every annotation is `untracked`.
    const before = auditSourceDigests(corpus, loadAbilityAnnotations(root));
    expect(before.summary.untracked).toBe(3);

    backfill(corpus, root);

    const after = auditSourceDigests(corpus, loadAbilityAnnotations(root));
    expect(after.findings).toEqual([]);
    expect(after.summary.current).toBe(3);
  });

  it("cleans up its temporary file", () => {
    const root = repoFixture({ necrons: [record("fabricated-ability")] });
    backfill({ necrons: { "fabricated-ability": FABRICATED_RULE } }, root);

    expect(
      readdirSync(join(root, "data", "enrichment", "necrons")),
    ).toEqual(["abilities.json"]);
  });

  // Root ignores directory permissions, so the fault this case provokes cannot
  // be provoked at all when the suite runs as root.
  const asNonRoot =
    typeof process.getuid === "function" && process.getuid() === 0 ? it.skip : it;

  asNonRoot("reports how far an I/O fault got, using relative paths only", () => {
    const root = repoFixture({
      _core: [record("shared-ability", { faction_id: null })],
      necrons: [record("fabricated-ability")],
    });
    const plan = planSourceDigestBackfill(
      {
        _core: { "shared-ability": FABRICATED_OTHER_RULE },
        necrons: { "fabricated-ability": FABRICATED_RULE },
      },
      loadAbilityAnnotationFiles(root),
    );
    // `_core` writes first; make the second destination directory unwritable so
    // the rename fails there.
    const necronsDir = join(root, "data", "enrichment", "necrons");
    chmodSync(necronsDir, 0o500);
    try {
      let message = "";
      expect(() => {
        try {
          writeSourceDigestBackfill(plan);
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      }).toThrow(
        /I\/O fault writing data\/enrichment\/necrons\/abilities\.json \(EACCES\) after 1\/2 file\(s\) written/,
      );
      expect(message).toContain(
        "Written: data/enrichment/_core/abilities.json.",
      );
      // Node's own errno messages embed the absolute path; the command must not
      // pass one through.
      expect(message).not.toContain(root);
    } finally {
      chmodSync(necronsDir, 0o700);
    }
  });
});

describe("source-digest backfill --allow-untracked", () => {
  /**
   * A tree shaped like the real gap: most annotations resolve, and a few never
   * can — a structural uniqueness restriction with no printed rule at all, an
   * annotation whose id does not match the printed name, and one the dump
   * cannot disambiguate.
   */
  const gapped = (): string =>
    repoFixture({
      _core: [record("shared-ability")],
      "adeptus-astartes": [
        record("resolvable-ability"),
        record("fabricated-unique-unit-limit"),
      ],
      orks: [record("fabricated-orphaned-ability")],
    });

  /** Covers everything in `gapped()` except the three unresolvable ids. */
  const partialCorpus = {
    _core: { "shared-ability": FABRICATED_RULE },
    "adeptus-astartes": { "resolvable-ability": FABRICATED_OTHER_RULE },
  };

  it("skips gapped annotations and still writes the resolvable ones", () => {
    const root = gapped();
    const plan = planSourceDigestBackfill(
      partialCorpus,
      loadAbilityAnnotationFiles(root),
      { allowUntracked: true },
    );
    writeSourceDigestBackfill(plan);

    expect(plan.report.summary).toEqual({
      annotations: 4,
      corpus_entries: 2,
      files_scanned: 3,
      files_changed: 2,
      unchanged: 0,
      skipped: 2,
      added: 2,
      replaced: 0,
    });
    // The two resolvable annotations got their digests…
    expect(readAbilities(root, "_core")[0].source_digest).toBe(DIGEST);
    expect(readAbilities(root, "adeptus-astartes")[0].source_digest).toBe(
      OTHER_DIGEST,
    );
    // …and the gapped ones were left exactly as authored.
    expect(readAbilities(root, "adeptus-astartes")[1]).not.toHaveProperty(
      "source_digest",
    );
    expect(readAbilities(root, "orks")[0]).not.toHaveProperty("source_digest");
  });

  it("does not rewrite a file whose every annotation was skipped", () => {
    const root = gapped();
    const before = readRaw(root, "orks");

    const plan = planSourceDigestBackfill(
      partialCorpus,
      loadAbilityAnnotationFiles(root),
      { allowUntracked: true },
    );
    writeSourceDigestBackfill(plan);

    expect(plan.report.files.map((file) => file.file)).toEqual([
      "data/enrichment/_core/abilities.json",
      "data/enrichment/adeptus-astartes/abilities.json",
    ]);
    expect(readRaw(root, "orks")).toBe(before);
  });

  it("leaves an existing digest on a gapped annotation untouched", () => {
    // A previously-fingerprinted annotation that has since dropped out of the
    // corpus must not be refreshed and must not be cleared: skipping is inert.
    const root = repoFixture({
      necrons: [
        record("resolvable-ability"),
        record("fabricated-gapped-ability", { source_digest: STALE_DIGEST }),
      ],
    });

    const plan = planSourceDigestBackfill(
      { necrons: { "resolvable-ability": FABRICATED_RULE } },
      loadAbilityAnnotationFiles(root),
      { allowUntracked: true },
    );
    writeSourceDigestBackfill(plan);

    const after = readAbilities(root, "necrons");
    expect(after[0].source_digest).toBe(DIGEST);
    expect(after[1].source_digest).toBe(STALE_DIGEST);
    expect(plan.report.summary.skipped).toBe(1);
    expect(plan.report.summary.replaced).toBe(0);
  });

  it("is idempotent, skipping the same annotations on a second run", () => {
    const root = gapped();
    const options = { allowUntracked: true };

    const first = planSourceDigestBackfill(
      partialCorpus,
      loadAbilityAnnotationFiles(root),
      options,
    );
    writeSourceDigestBackfill(first);
    const bytes = readRaw(root, "adeptus-astartes");

    const second = planSourceDigestBackfill(
      partialCorpus,
      loadAbilityAnnotationFiles(root),
      options,
    );
    writeSourceDigestBackfill(second);

    expect(second.writes).toEqual([]);
    expect(second.report.summary).toMatchObject({
      files_changed: 0,
      added: 0,
      replaced: 0,
      unchanged: 2,
      skipped: 2,
    });
    expect(readRaw(root, "adeptus-astartes")).toBe(bytes);
  });

  it("the default still aborts on the same fixture, and names the flag", () => {
    const root = gapped();
    const before = readRaw(root, "adeptus-astartes");

    expect(() =>
      planSourceDigestBackfill(partialCorpus, loadAbilityAnnotationFiles(root)),
    ).toThrow(
      /2 annotation\(s\) have no corpus entry \(adeptus-astartes\/fabricated-unique-unit-limit, orks\/fabricated-orphaned-ability; pass --allow-untracked to skip them instead\)/,
    );
    expect(readRaw(root, "adeptus-astartes")).toBe(before);
  });

  it("relaxes only the annotation-side gap — every other abort still aborts", () => {
    const root = gapped();
    const options = { allowUntracked: true };
    const files = loadAbilityAnnotationFiles(root);

    // An unknown corpus key means the corpus and the repository disagree about
    // what exists; the flag says nothing about that direction.
    expect(() =>
      planSourceDigestBackfill(
        { ...partialCorpus, tyranids: { "unknown-ability": FABRICATED_RULE } },
        files,
        options,
      ),
    ).toThrow(/1 corpus entr\(y\/ies\) have no annotation \(tyranids\/unknown-ability\)/);

    // A malformed corpus, an invalid value, and an empty-after-normalisation
    // value are all still invocation errors.
    for (const corpus of [
      "fabricated",
      { "adeptus-astartes": FABRICATED_RULE },
      { ...partialCorpus, orks: { "fabricated-orphaned-ability": 7 } },
      { ...partialCorpus, orks: { "fabricated-orphaned-ability": " ,. " } },
      {
        ...partialCorpus,
        "adeptus-astartes": {
          ...partialCorpus["adeptus-astartes"],
          [FABRICATED_NAME]: FABRICATED_RULE,
        },
      },
    ]) {
      expect(() =>
        planSourceDigestBackfill(corpus, files, options),
      ).toThrow(/source corpus/);
    }

    // A duplicate composite identity is still ambiguous, flag or no flag.
    expect(() =>
      planSourceDigestBackfill(partialCorpus, [...files, ...files], options),
    ).toThrow(/duplicate identity/);

    // So is a misaligned identity list.
    expect(() =>
      planSourceDigestBackfill(
        partialCorpus,
        files.map((file) =>
          file.relative.includes("adeptus-astartes")
            ? { ...file, annotations: file.annotations.slice(0, 1) }
            : file,
        ),
        options,
      ),
    ).toThrow(/1 identities for 2 records/);

    // A malformed ability file never reaches the projection at all.
    writeJSON(abilityFile(root, "orks"), { "not-an": "array" });
    expect(() => loadAbilityAnnotationFiles(root)).toThrow(
      /expected a JSON array/,
    );
  });

  it("keeps the skipped count out of the prose and paths it reports", () => {
    const root = gapped();
    const plan = planSourceDigestBackfill(
      partialCorpus,
      loadAbilityAnnotationFiles(root),
      { allowUntracked: true },
    );

    expect(plan.report.summary.skipped).toBe(2);
    expect(renderSourceDigestBackfill(plan.report)).toContain("skipped 2");
    for (const text of [
      JSON.stringify(plan.report),
      renderSourceDigestBackfill(plan.report),
    ]) {
      for (const sentinel of [
        FABRICATED_RULE,
        FABRICATED_OTHER_RULE,
        FABRICATED_NAME,
        DIGEST,
        OTHER_DIGEST,
      ]) {
        expect(text).not.toContain(sentinel);
      }
      expect(text).not.toContain(root);
      // The count is reported, but the skipped identities are not enumerated
      // here — `audit:source-digest` is where the full list lives.
      expect(text).not.toContain("fabricated-unique-unit-limit");
    }
  });

  it("still leaves the audit reporting the gap as a finding", () => {
    // The flag is a write-side allowance, not a blessing: the audit must keep
    // surfacing the unresolvable annotations and keep exiting nonzero.
    const root = gapped();
    writeSourceDigestBackfill(
      planSourceDigestBackfill(partialCorpus, loadAbilityAnnotationFiles(root), {
        allowUntracked: true,
      }),
    );

    const report = auditSourceDigests(partialCorpus, loadAbilityAnnotations(root));
    expect(report.summary.current).toBe(2);
    // `missing-source`, not `untracked`: the corpus has no entry at all, which
    // is the more precise diagnosis and still a finding.
    expect(report.findings).toEqual([
      {
        faction_id: "adeptus-astartes",
        ability_id: "fabricated-unique-unit-limit",
        status: "missing-source",
      },
      {
        faction_id: "orks",
        ability_id: "fabricated-orphaned-ability",
        status: "missing-source",
      },
    ]);
    expect(report.summary.findings).toBe(2);
  });
});

describe("renderSourceDigestBackfill", () => {
  it("renders a stable no-change block", () => {
    const root = repoFixture({
      necrons: [record("fabricated-ability", { source_digest: DIGEST })],
    });
    const plan = planSourceDigestBackfill(
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      loadAbilityAnnotationFiles(root),
    );

    expect(renderSourceDigestBackfill(plan.report)).toBe(
      "source-digest backfill — 1 annotations, 1 corpus entries, 1 files scanned\n" +
        "added 0  replaced 0  unchanged 1  skipped 0  changed 0 file(s)\n" +
        "no changes\n",
    );
  });

  it("renders one line per changed file and marks a dry run", () => {
    const root = repoFixture({
      necrons: [
        record("added-ability"),
        record("replaced-ability", { source_digest: STALE_DIGEST }),
      ],
    });
    const plan = planSourceDigestBackfill(
      {
        necrons: {
          "added-ability": FABRICATED_RULE,
          "replaced-ability": FABRICATED_REWORD,
        },
      },
      loadAbilityAnnotationFiles(root),
    );

    expect(renderSourceDigestBackfill(plan.report)).toBe(
      "source-digest backfill — 2 annotations, 2 corpus entries, 1 files scanned\n" +
        "added 1  replaced 1  unchanged 0  skipped 0  changed 1 file(s)\n" +
        "1+ 1~ data/enrichment/necrons/abilities.json\n",
    );
    expect(
      renderSourceDigestBackfill(plan.report, { dryRun: true }),
    ).toContain("would change 1 file(s)");
  });
});

describe("source-digest backfill redaction", () => {
  const sentinels = [
    FABRICATED_RULE,
    FABRICATED_REWORD,
    FABRICATED_OTHER_RULE,
    "Fabricated Rule Secret",
    FABRICATED_NAME,
    DIGEST,
    REWORD_DIGEST,
    OTHER_DIGEST,
  ];

  it("keeps prose, names, digests and private paths out of the report", () => {
    const root = repoFixture({
      necrons: [
        record("added-ability"),
        record("replaced-ability", { source_digest: STALE_DIGEST }),
      ],
    });
    const plan = planSourceDigestBackfill(
      {
        necrons: {
          "added-ability": FABRICATED_RULE,
          "replaced-ability": FABRICATED_REWORD,
        },
      },
      loadAbilityAnnotationFiles(root),
    );

    for (const text of [
      JSON.stringify(plan.report),
      renderSourceDigestBackfill(plan.report),
    ]) {
      for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
      expect(text).not.toContain(root);
      expect(text).not.toContain(
        "backfill-source-digest-fabricated-path-fragment",
      );
    }
  });

  it("keeps prose and unvalidated keys out of every abort message", () => {
    const root = repoFixture({
      necrons: [record("fabricated-ability"), record("other-ability")],
    });
    const files = loadAbilityAnnotationFiles(root);
    const rejected: unknown[] = [
      FABRICATED_RULE,
      { necrons: FABRICATED_RULE },
      { necrons: { "fabricated-ability": FABRICATED_RULE, [FABRICATED_NAME]: FABRICATED_RULE } },
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      {
        necrons: {
          "fabricated-ability": FABRICATED_RULE,
          "other-ability": FABRICATED_REWORD,
        },
        orks: { "unknown-ability": FABRICATED_OTHER_RULE },
      },
    ];

    for (const corpus of rejected) {
      let message = "";
      expect(() => {
        try {
          planSourceDigestBackfill(corpus, files);
        } catch (error) {
          message = (error as Error).message;
          throw error;
        }
      }).toThrow();
      for (const sentinel of sentinels) expect(message).not.toContain(sentinel);
      expect(message).not.toContain(root);
    }
  });

  it("names the identities behind an incomplete join, and nothing else", () => {
    const root = repoFixture({
      necrons: [record("fabricated-ability"), record("other-ability")],
    });

    expect(() =>
      planSourceDigestBackfill(
        {
          necrons: { "fabricated-ability": FABRICATED_RULE },
          orks: { "unknown-ability": FABRICATED_RULE },
        },
        loadAbilityAnnotationFiles(root),
      ),
    ).toThrow(
      /1 annotation\(s\) have no corpus entry \(necrons\/other-ability; pass --allow-untracked to skip them instead\); 1 corpus entr\(y\/ies\) have no annotation \(orks\/unknown-ability\)/,
    );
  });

  it("caps the listed identities and points at the audit for the rest", () => {
    const many = Array.from({ length: 14 }, (_unused, index) =>
      record(`fabricated-ability-${index}`),
    );
    const root = repoFixture({ necrons: many });

    let message = "";
    try {
      planSourceDigestBackfill({ necrons: {} }, loadAbilityAnnotationFiles(root));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("14 annotation(s) have no corpus entry");
    expect(message).toContain("and 4 more");
    expect(message).toContain("npm run audit:source-digest");
    // 10 listed, so the 11th onwards must not appear. Ids sort by code unit:
    // `-0`, `-1`, `-10`, `-11`, `-12`, `-13`, `-2` … so `-6` is beyond the cap.
    expect(message).not.toContain("fabricated-ability-6");
  });
});

describe("parseBackfillArgs", () => {
  it("defaults the root and accepts flags in any position", () => {
    expect(parseBackfillArgs(["corpus.json"])).toEqual({
      corpus: resolve("corpus.json"),
      rootDir: resolve(TOOLS, ".."),
      dryRun: false,
      allowUntracked: false,
    });
    expect(
      parseBackfillArgs([
        "--dry-run",
        "--root",
        "/tmp/root",
        "corpus.json",
        "--allow-untracked",
      ]),
    ).toEqual({
      corpus: resolve("corpus.json"),
      rootDir: resolve("/tmp/root"),
      dryRun: true,
      allowUntracked: true,
    });
  });

  it("defaults --allow-untracked off, so the strict join is the default", () => {
    expect(parseBackfillArgs(["corpus.json"]).allowUntracked).toBe(false);
    expect(
      parseBackfillArgs(["corpus.json", "--allow-untracked"]).allowUntracked,
    ).toBe(true);
  });

  const bad: [string, string[]][] = [
    ["no corpus", []],
    ["no corpus with flags", ["--root", "/tmp/root", "--dry-run"]],
    ["a second positional", ["corpus.json", "extra.json"]],
    ["--root without a value", ["corpus.json", "--root"]],
    ["--root followed by a flag", ["corpus.json", "--root", "--dry-run"]],
    ["an unknown flag", ["corpus.json", "--fabricated-flag-secret"]],
  ];

  for (const [label, argv] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => parseBackfillArgs(argv)).toThrow(/^usage: /);
      try {
        parseBackfillArgs(argv);
      } catch (error) {
        expect((error as Error).message).not.toContain("fabricated-flag-secret");
      }
    });
  }
});

describe("backfill:source-digest command", () => {
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
      _core: [record("shared-ability", { faction_id: null })],
      necrons: [record("fabricated-ability")],
    });

  const fullCorpus = {
    _core: { "shared-ability": FABRICATED_OTHER_RULE },
    necrons: { "fabricated-ability": FABRICATED_RULE },
  };

  it("exits 0 and writes the digests for a complete corpus", () => {
    const root = liveRepo();
    const result = run(fullCorpus, root);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("added 2");
    expect(result.stdout).toContain("data/enrichment/necrons/abilities.json");
    expect(readAbilities(root, "necrons")[0].source_digest).toBe(DIGEST);
    expect(readAbilities(root, "_core")[0].source_digest).toBe(OTHER_DIGEST);
  });

  it("writes nothing under --dry-run but still reports the projection", () => {
    const root = liveRepo();
    const result = run(fullCorpus, root, ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change 2 file(s)");
    expect(readAbilities(root, "necrons")[0]).not.toHaveProperty(
      "source_digest",
    );
  });

  it("exits 1 and writes nothing for an incomplete join", () => {
    const root = liveRepo();
    const result = run(
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      root,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("refusing to write");
    expect(result.stderr).toContain("_core/shared-ability");
    expect(result.stderr).toContain("pass --allow-untracked");
    expect(readAbilities(root, "necrons")[0]).not.toHaveProperty(
      "source_digest",
    );
  });

  it("exits 0 under --allow-untracked, writing only what resolved", () => {
    const root = liveRepo();
    const partial = { necrons: { "fabricated-ability": FABRICATED_RULE } };

    // Same fixture, same corpus: the default aborts…
    expect(run(partial, root).status).toBe(1);
    expect(readAbilities(root, "necrons")[0]).not.toHaveProperty(
      "source_digest",
    );

    // …and the flag turns the annotation-side gap into a reported skip.
    const allowed = run(partial, root, ["--allow-untracked"]);
    expect(allowed.stderr).toBe("");
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain("added 1");
    expect(allowed.stdout).toContain("skipped 1");
    expect(readAbilities(root, "necrons")[0].source_digest).toBe(DIGEST);
    expect(readAbilities(root, "_core")[0]).not.toHaveProperty("source_digest");
  });

  it("still exits 1 under --allow-untracked for an unknown corpus key", () => {
    const root = liveRepo();
    const result = run(
      { ...fullCorpus, tyranids: { "unknown-ability": FABRICATED_RULE } },
      root,
      ["--allow-untracked"],
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("tyranids/unknown-ability");
    expect(readAbilities(root, "necrons")[0]).not.toHaveProperty(
      "source_digest",
    );
  });

  it("combines --allow-untracked with --dry-run without writing", () => {
    const root = liveRepo();
    const result = run(
      { necrons: { "fabricated-ability": FABRICATED_RULE } },
      root,
      ["--allow-untracked", "--dry-run"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped 1");
    expect(result.stdout).toContain("would change 1 file(s)");
    expect(readAbilities(root, "necrons")[0]).not.toHaveProperty(
      "source_digest",
    );
  });

  it("exits 1 and writes nothing for a malformed corpus", () => {
    const root = liveRepo();
    const result = run({ necrons: FABRICATED_RULE }, root);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('source corpus["necrons"]');
    expect(readAbilities(root, "necrons")[0]).not.toHaveProperty(
      "source_digest",
    );
  });

  it("exits 1 on a bad invocation", () => {
    const root = liveRepo();
    const noCorpus = spawnSync(
      process.execPath,
      [TSX, SCRIPT, "--root", root],
      { encoding: "utf-8", cwd: TOOLS },
    );
    expect(noCorpus.status).toBe(1);
    expect(noCorpus.stderr).toContain("usage:");

    const extraArg = run(fullCorpus, root, ["fabricated-extra-argument"]);
    expect(extraArg.status).toBe(1);
    expect(extraArg.stderr).toContain("usage:");
  });

  it("exits 1 for an unreadable corpus without echoing its path", () => {
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

  it("is idempotent across two invocations", () => {
    const root = liveRepo();
    expect(run(fullCorpus, root).status).toBe(0);
    const bytes = readRaw(root, "necrons");

    const second = run(fullCorpus, root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("no changes");
    expect(readRaw(root, "necrons")).toBe(bytes);
  });

  it("leaks no prose, digest, name or private path on any stream", () => {
    for (const result of [
      run(fullCorpus, liveRepo()),
      run(fullCorpus, liveRepo(), ["--dry-run"]),
      run({ necrons: { "fabricated-ability": FABRICATED_RULE } }, liveRepo()),
      run({ necrons: FABRICATED_RULE }, liveRepo()),
    ]) {
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toContain("Fabricated Rule Secret");
        expect(stream).not.toContain("Fabricated Other Rule Secret");
        expect(stream).not.toContain(FABRICATED_NAME);
        expect(stream).not.toContain(DIGEST);
        expect(stream).not.toContain(OTHER_DIGEST);
        expect(stream).not.toContain(result.corpusPath);
        expect(stream).not.toContain("fabricated-corpus-secret");
        expect(stream).not.toContain(
          "backfill-source-digest-fabricated-path-fragment",
        );
      }
    }
  });
});
