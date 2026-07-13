/**
 * The `share-v1` compact list codec: round-trip fidelity (including the
 * allied-source / grants / disposition / attachment fields that the
 * roster-json round-trip drops), URL-safety, compactness, and the
 * stale-registry failure path.
 */
import { describe, expect, it } from "vitest";
import { gzipSync, strToU8 } from "fflate";

import { dataset } from "../src/data/index.js";
import {
  decodeShareList,
  encodeShareList,
  SHARE_FORMAT_VERSION,
  type ShareList,
} from "../src/share/codec.js";
import { rosterToShareList } from "../src/share/from-roster.js";
import { SHARE_KINDS, ShareRegistryIndex, type ShareKind } from "../src/share/registry.js";
import { SHARE_REGISTRY } from "../src/share/registry.generated.js";
import type { ResolvedRef, Roster, RosterUnit } from "../src/import/types.js";

const index = new ShareRegistryIndex(SHARE_REGISTRY);

/** A list exercising every encoder branch with real, registry-known ids. */
function sampleList(): ShareList {
  const faction = "adeptus-astartes";
  const detIds = dataset.detachments.all
    .filter((d) => d.faction_id === faction)
    .map((d) => d.id);
  const units = dataset.units.byFaction(faction);
  const unitA = units[0].id;
  const unitB = units[1].id;
  const [w0, w1, w2] = dataset.weapons.all.map((w) => w.id);
  const enhancementId =
    dataset.enhancements.all.find((e) => (e as { faction_id?: string }).faction_id === faction)
      ?.id ?? dataset.enhancements.all[0].id;
  const disposition = dataset.forceDispositions.all[0]?.id ?? null;
  const allyFactionId = "chaos-daemons";
  const allyRuleId = dataset.alliedRules.all[0]?.id ?? null;

  return {
    name: "Strîke Force 🔨",
    factionId: faction,
    detachmentIds: detIds.slice(0, 2),
    battleSize: "strike-force",
    disposition,
    units: [
      {
        datasheetId: unitA,
        modelCount: 5,
        isWarlord: true,
        enhancementId,
        allyFactionId: null,
        allyRuleId: null,
        attachedToOrdinal: null,
        grants: ["Character"],
        loadout: [
          [w0, 2],
          [w1, 1],
        ],
      },
      {
        datasheetId: unitB,
        modelCount: 1,
        isWarlord: false,
        enhancementId: null,
        allyFactionId,
        allyRuleId,
        attachedToOrdinal: 0, // attaches to unitA above
        grants: [],
        loadout: [[w2, 1]],
      },
    ],
  };
}

describe("share-v1 codec", () => {
  it("allocates every current shareable id and documents stale slots", () => {
    const currentIds: Record<ShareKind, Set<string>> = {
      faction: new Set(dataset.factions.all.map((entity) => entity.id)),
      detachment: new Set(dataset.detachments.all.map((entity) => entity.id)),
      unit: new Set(dataset.units.all.map((entity) => entity.id)),
      wargear: new Set(
        [...dataset.weapons.all, ...dataset.wargear.all].map((entity) => entity.id),
      ),
      enhancement: new Set(dataset.enhancements.all.map((entity) => entity.id)),
      ally_rule: new Set(dataset.alliedRules.all.map((entity) => entity.id)),
      disposition: new Set(dataset.forceDispositions.all.map((entity) => entity.id)),
    };

    const missing = Object.fromEntries(
      SHARE_KINDS.map((kind) => [
        kind,
        [...currentIds[kind]].filter((id) => !SHARE_REGISTRY.kinds[kind].includes(id)),
      ]).filter(([, ids]) => ids.length > 0),
    );
    expect(missing).toEqual({});

    const aliases = new Set(Object.keys(SHARE_REGISTRY.aliases));
    const tombstones = new Set(SHARE_REGISTRY.tombstones);
    const undocumentedStale = Object.fromEntries(
      SHARE_KINDS.map((kind) => [
        kind,
        SHARE_REGISTRY.kinds[kind].filter(
          (id) => !currentIds[kind].has(id) && !aliases.has(id) && !tombstones.has(id),
        ),
      ]).filter(([, ids]) => ids.length > 0),
    );
    expect(undocumentedStale).toEqual({});
  });
  it("round-trips a list losslessly, including allies/grants/disposition/attachment", () => {
    const list = sampleList();
    const token = encodeShareList(list, index);
    const result = decodeShareList(token, index);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.list).toEqual(list);
  });

  it("produces a URL-safe, padding-free token", () => {
    const token = encodeShareList(sampleList(), index);
    expect(token).not.toMatch(/[+/=]/);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("starts with the format-version byte", () => {
    // base64url of a buffer whose first byte is SHARE_FORMAT_VERSION (1).
    const token = encodeShareList(sampleList(), index);
    const first = atob(token.slice(0, 2).replace(/-/g, "+").replace(/_/g, "/") + "==");
    expect(first.charCodeAt(0)).toBe(SHARE_FORMAT_VERSION);
  });

  it("is dramatically smaller than gzipped roster-json for the same list", () => {
    const list = sampleList();
    const token = encodeShareList(list, index);
    // A faithful (and far more verbose) roster-json-shaped payload for the same
    // list — names, points, diagnostics, candidates, whitespace — gzipped, the
    // way the old share link encoded it. The compact token must beat it handily.
    const verbose = JSON.stringify(
      {
        name: list.name,
        source: { format: "roster-json", generated_by: "x" },
        faction_id: list.factionId,
        detachments: list.detachmentIds.map((id) => ({
          ref: { id, raw_name: id, resolved: true, candidates: [] },
          dp_cost: 3,
        })),
        battle_size: list.battleSize,
        points: { declared_limit: 2000, detachment_cap: 3, total_reported: 0, total_computed: 0 },
        units: list.units.map((u) => ({
          ref: { id: u.datasheetId, raw_name: u.datasheetId, resolved: true, candidates: [] },
          model_count: u.modelCount,
          points: 100,
          is_warlord: u.isWarlord,
          enhancement: u.enhancementId
            ? { id: u.enhancementId, raw_name: u.enhancementId, resolved: true, candidates: [] }
            : null,
          enhancement_points: null,
          wargear: u.loadout.map(([id, count]) => ({
            ref: { id, raw_name: id, resolved: true, candidates: [] },
            count,
          })),
          leader_attachment: null,
        })),
        game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
        diagnostics: {
          resolved_units: 2,
          unresolved_units: 0,
          resolved_weapons: 0,
          unresolved_weapons: 0,
          warnings: [],
        },
      },
      null,
      2,
    );
    const legacyLen = gzipSync(strToU8(verbose)).length;
    expect(token.length).toBeLessThan(legacyLen);
  });

  it("reports stale-registry when a token references an unknown slot", () => {
    const token = encodeShareList(sampleList(), index);
    // Decode against an empty registry: the faction slot is out of range.
    const emptyIndex = new ShareRegistryIndex({
      version: 0,
      kinds: {
        faction: [],
        detachment: [],
        unit: [],
        wargear: [],
        enhancement: [],
        ally_rule: [],
        disposition: [],
      },
      aliases: {},
      tombstones: [],
    });
    expect(decodeShareList(token, emptyIndex)).toEqual({ ok: false, reason: "stale-registry" });
  });

  it("reports malformed on garbage input", () => {
    expect(decodeShareList("", index)).toEqual({ ok: false, reason: "malformed" });
    expect(decodeShareList("!!!not-base64!!!", index)).toEqual({ ok: false, reason: "malformed" });
    // A buffer whose first byte isn't the format version.
    expect(decodeShareList("AAAA", index).ok).toBe(false);
  });

  it("applies aliases: a renamed id round-trips to its current id", () => {
    // Synthetic registry: slot 0 holds an old faction id, aliased to a new one.
    const aliased = new ShareRegistryIndex({
      version: 5,
      kinds: {
        faction: ["old-faction"],
        detachment: [],
        unit: [],
        wargear: [],
        enhancement: [],
        ally_rule: [],
        disposition: [],
      },
      aliases: { "old-faction": "new-faction" },
      tombstones: [],
    });
    const list: ShareList = {
      name: "",
      factionId: "new-faction", // current id; encoder must find the aliased slot
      detachmentIds: [],
      battleSize: "incursion",
      disposition: null,
      units: [],
    };
    const decoded = decodeShareList(encodeShareList(list, aliased), aliased);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.list.factionId).toBe("new-faction");
  });
});

// ── rosterToShareList (importer → share-token bridge) ────────────────────────

const ref = (id: string | null, raw_name = id ?? "Unknown"): ResolvedRef => ({
  id,
  raw_name,
  resolved: id !== null,
  candidates: [],
});

function rosterUnit(over: Partial<RosterUnit> & { ref: ResolvedRef }): RosterUnit {
  return {
    model_count: 1,
    points: 100,
    is_warlord: false,
    enhancement: null,
    enhancement_points: null,
    wargear: [],
    leader_attachment: null,
    ...over,
  };
}

function roster(over: Partial<Roster>): Roster {
  return {
    name: "Test list",
    source: { format: "roster-json", generated_by: null },
    faction_id: null,
    detachments: [],
    battle_size: "strike-force",
    force_disposition: null,
    points: { declared_limit: 2000, detachment_cap: 3, total_reported: null, total_computed: 0 },
    units: [],
    game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
    diagnostics: {
      resolved_units: 0,
      unresolved_units: 0,
      resolved_weapons: 0,
      unresolved_weapons: 0,
      warnings: [],
    },
    ...over,
  };
}

describe("rosterToShareList", () => {
  const faction = "adeptus-astartes";
  const units = dataset.units.byFaction(faction);
  const unitA = units[0].id;
  const unitB = units[1].id;
  const [w0, w1] = dataset.weapons.all.map((w) => w.id);
  const detId = dataset.detachments.all.find((d) => d.faction_id === faction)!.id;
  const enhId =
    dataset.enhancements.all.find((e) => (e as { faction_id?: string }).faction_id === faction)
      ?.id ?? dataset.enhancements.all[0].id;
  const disposition = dataset.forceDispositions.all[0]?.id ?? null;

  it("maps fields and round-trips a fully-resolved roster", () => {
    const r = roster({
      name: "Strike Force 🔨",
      faction_id: faction,
      detachments: [{ ref: ref(detId), dp_cost: 3 }],
      battle_size: "strike-force",
      force_disposition: disposition,
      units: [
        rosterUnit({
          ref: ref(unitA),
          model_count: 5,
          is_warlord: true,
          enhancement: ref(enhId),
          wargear: [
            { ref: ref(w0), count: 2 },
            { ref: ref(w1), count: 1 },
          ],
        }),
        rosterUnit({
          ref: ref(unitB),
          // A leader attaching to the first unit by bodyguard ref.
          leader_attachment: { bodyguard_ref: ref(unitA), role: "leader", provisional: false },
        }),
      ],
    });

    const share = rosterToShareList(r, index);
    expect(share.units).toHaveLength(2);
    expect(share.factionId).toBe(faction);
    expect(share.detachmentIds).toEqual([detId]);
    expect(share.disposition).toBe(disposition);
    expect(share.units[0]).toMatchObject({
      datasheetId: unitA,
      modelCount: 5,
      isWarlord: true,
      enhancementId: enhId,
      loadout: [
        [w0, 2],
        [w1, 1],
      ],
    });
    // The leader's attachedToOrdinal points at unitA's ordinal in the share list.
    expect(share.units[1].attachedToOrdinal).toBe(0);

    // Full round-trip through the real codec.
    const decoded = decodeShareList(encodeShareList(share, index), index);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.list).toEqual(share);
  });

  it("defaults a null battle size to strike-force", () => {
    const share = rosterToShareList(roster({ battle_size: null }), index);
    expect(share.battleSize).toBe("strike-force");
  });

  it("drops unresolved units and keeps attachment ordinals in the emitted list", () => {
    const r = roster({
      units: [
        rosterUnit({ ref: ref(null, "Mystery Unit") }), // unresolved → dropped
        rosterUnit({ ref: ref(unitA) }), // emitted ordinal 0
        rosterUnit({
          ref: ref(unitB), // emitted ordinal 1
          leader_attachment: { bodyguard_ref: ref(unitA), role: "leader", provisional: false },
        }),
      ],
    });
    const share = rosterToShareList(r, index);
    expect(share.units.map((u) => u.datasheetId)).toEqual([unitA, unitB]);
    // unitA is emitted at index 0 even though it was second in the roster.
    expect(share.units[1].attachedToOrdinal).toBe(0);
  });

  it("drops resolved ids the registry doesn't know", () => {
    const r = roster({
      faction_id: "totally-made-up-faction",
      detachments: [{ ref: ref("totally-made-up-detachment"), dp_cost: 3 }],
      units: [
        rosterUnit({ ref: ref("totally-made-up-unit") }),
        rosterUnit({
          ref: ref(unitA),
          enhancement: ref("totally-made-up-enhancement"),
          wargear: [{ ref: ref("totally-made-up-weapon"), count: 1 }],
        }),
      ],
    });
    const share = rosterToShareList(r, index);
    expect(share.factionId).toBeNull();
    expect(share.detachmentIds).toEqual([]);
    expect(share.units.map((u) => u.datasheetId)).toEqual([unitA]);
    expect(share.units[0].enhancementId).toBeNull();
    expect(share.units[0].loadout).toEqual([]);
    // Whatever survives must still encode cleanly.
    expect(() => encodeShareList(share, index)).not.toThrow();
  });
});
