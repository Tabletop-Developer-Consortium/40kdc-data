/**
 * Source-normalization tests for `projectInvulnerableSave` (issue #87). These
 * exercise the projection CONTRACT — structured scoped columns, the closed set of
 * English attack-scope footnotes, the value-always-from-`save` rule, ignored
 * model rows, and conflict detection — not a snapshot of any GW source text.
 */
import { describe, it, expect } from "vitest";
import { projectInvulnerableSave } from "../src/mfm/project-loadout.js";

type Row = {
  save?: string | null;
  rangedSave?: string | null;
  meleeSave?: string | null;
  miniatureId?: string | null;
  rules?: string | null;
};

/** Build one invulnerable_save row; `rules` becomes localisations.en.rules. */
const row = (r: Row): Record<string, unknown> => ({
  id: "inv",
  datasheetId: "ds",
  miniatureId: r.miniatureId ?? null,
  save: r.save ?? null,
  rangedSave: r.rangedSave ?? null,
  meleeSave: r.meleeSave ?? null,
  localisations: { en: { rules: r.rules ?? "" } },
});

describe("projectInvulnerableSave — structured columns", () => {
  it("keeps unconditional + ranged + melee from one structured row", () => {
    const p = projectInvulnerableSave([row({ save: "5+", rangedSave: "6+", meleeSave: "4+" })]);
    expect(p).toMatchObject({ invuln_sv: 5, invuln_sv_ranged: 6, invuln_sv_melee: 4, found: true });
    expect(p.warnings).toEqual([]);
  });

  it("projects the observed Wyches dual-scope row (no unconditional)", () => {
    const p = projectInvulnerableSave([
      row({ save: null, rangedSave: "6+", meleeSave: "4+", rules: "*4+ against melee attacks only*" }),
    ]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: 6, invuln_sv_melee: 4, found: true });
    expect(p.warnings).toEqual([]);
  });
});

describe("projectInvulnerableSave — recognized attack-scope footnotes", () => {
  it("ranged: plain form (with and without trailing period), save moves off unconditional", () => {
    for (const rules of ["*Against ranged attacks only*", "*Against ranged attacks only.*", "Against ranged attacks only"]) {
      const p = projectInvulnerableSave([row({ save: "5+", rules })]);
      expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: 5, invuln_sv_melee: null });
    }
  });

  it("melee: plain form", () => {
    const p = projectInvulnerableSave([row({ save: "4+", rules: "*Against melee attacks only*" })]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: null, invuln_sv_melee: 4 });
  });

  it("ranged: '<N>+ against ranged attacks only' when N equals save", () => {
    const p = projectInvulnerableSave([row({ save: "5+", rules: "5+ against ranged attacks only" })]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: 5 });
  });

  it("melee: '<N>+ against melee attacks only' when N equals save", () => {
    const p = projectInvulnerableSave([row({ save: "4+", rules: "*4+ against melee attacks only*" })]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_melee: 4 });
  });

  it("ranged: 'This model has a <N>+ invulnerable save against ranged attacks'", () => {
    const p = projectInvulnerableSave([
      row({ save: "5+", rules: "*This model has a 5+ invulnerable save against ranged attacks.*" }),
    ]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: 5 });
  });

  it("melee: analogous 'This model has a <N>+ invulnerable save against melee attacks'", () => {
    const p = projectInvulnerableSave([
      row({ save: "4+", rules: "This model has a 4+ invulnerable save against melee attacks" }),
    ]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_melee: 4 });
  });
});

describe("projectInvulnerableSave — footnote/save disagreement", () => {
  it("warns and leaves the row unprojected when footnote <N>+ != save", () => {
    const p = projectInvulnerableSave([row({ save: "5+", rules: "*4+ against melee attacks only*" })]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: null, invuln_sv_melee: null, found: true });
    expect(p.warnings).toHaveLength(1);
  });
});

describe("projectInvulnerableSave — unrecognized / ability-governed prose stays unconditional", () => {
  it("does not create a scoped value for 'See Shadow Field ability'", () => {
    const p = projectInvulnerableSave([row({ save: "5+", rules: "*See Shadow Field ability.*" })]);
    expect(p).toMatchObject({ invuln_sv: 5, invuln_sv_ranged: null, invuln_sv_melee: null });
    expect(p.warnings).toEqual([]);
  });

  it("does not create a scoped value for a model-only caveat", () => {
    const p = projectInvulnerableSave([row({ save: "6+", rules: "*Ibram Gaunt model only.*" })]);
    expect(p).toMatchObject({ invuln_sv: 6, invuln_sv_ranged: null, invuln_sv_melee: null });
  });
});

describe("projectInvulnerableSave — ignored and invalid rows", () => {
  it("ignores rows scoped to a specific model (miniatureId set)", () => {
    const p = projectInvulnerableSave([
      row({ save: "2+", miniatureId: "m-1", rules: "*You cannot re-roll invulnerable saving throws made for this model.*" }),
    ]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: null, invuln_sv_melee: null, found: false });
  });

  it("projects only the universal row when a model row is present too", () => {
    const p = projectInvulnerableSave([
      row({ save: "2+", miniatureId: "m-1" }),
      row({ save: "5+", rules: "*Against ranged attacks only*" }),
    ]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: 5, found: true });
  });

  it("warns and contributes nothing for a value that fails parseSkill", () => {
    const p = projectInvulnerableSave([row({ save: "7+" })]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: null, invuln_sv_melee: null, found: true });
    expect(p.warnings).toHaveLength(1);
  });
});

describe("projectInvulnerableSave — duplicate and conflicting rows", () => {
  it("combines duplicate equal universal rows without error", () => {
    const p = projectInvulnerableSave([
      row({ save: "5+", rules: "*Against ranged attacks only*" }),
      row({ save: "5+", rules: "*Against ranged attacks only*" }),
    ]);
    expect(p).toMatchObject({ invuln_sv: null, invuln_sv_ranged: 5 });
  });

  it("throws when two universal rows disagree on an output field", () => {
    expect(() =>
      projectInvulnerableSave([
        row({ save: "5+", rules: "*Against ranged attacks only*" }),
        row({ save: "6+", rules: "*Against ranged attacks only*" }),
      ]),
    ).toThrow(/conflicting/);
  });
});
