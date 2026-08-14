/**
 * enhancements.ts — Phase 3A: reconcile enhancement point costs against the
 * GW MFM dump.
 *
 * The repo enhancement id is `detachmentScopedId(name, detachment-name)`, which
 * is exactly how the dump's (enhancement, detachment) pair slugs — so matching is
 * a direct id lookup. For each matched enhancement we set the canon `cost`, clear
 * `points_provisional`, and stamp the confirmed launch dataslate (cost is the
 * provisional field here, so confirming it is precisely what those flags record —
 * unlike Phase 2 dispositions, where touching game_version would over-claim).
 *
 * Prose (`localisations.en.rules`/`lore`) is NOT handled here — it routes to the
 * out-of-repo store in a dedicated unified pass (3B), never into this repo.
 */
import * as fs from "fs";
import * as path from "path";
import { detachmentScopedId, nameToId } from "../converters/id-generator.js";
import { MfmDump, type DetachmentRow,
type EnhancementRow,
type MfmTableName, type MfmStringKey, type MfmRow, } from "./loader.js";
import { readJsonArray, CORE_DIR } from "./repo-files.js";
import { repoDirForFactionName, repoDirs } from "./faction-map.js";
import { requiredKeywordsForDetachment } from "./detachment-fields.js";
import { keywordLabel, factionKeywordLabel, keywordLabels } from "./keywords.js";
import type { StagedWrite } from "./apply.js";


const CONFIRMED = { edition: "11th", dataslate: "launch" };

interface EnhRecord {
  id: string;
  name: string;
  cost: number;
  points_provisional?: boolean;
  game_version?: { edition: string; dataslate: string };
  game_modes?: string[];
  upgrade_tag?: boolean;
  max_targets?: number;
  exclusion_keywords?: string[] | null;
  keyword_restrictions?: string[] | null;
  keyword_restriction_groups?: string[][] | null;
  attachment_bodyguard_ids?: string[];
  [k: string]: unknown;
}

interface DetachmentRecord {
  id: string;
  enhancement_ids?: string[];
  [k: string]: unknown;
}

export interface DirEnhResult {
  dir: string;
  matched: number;
  costChanged: { id: string; from: number; to: number }[];
  confirmed: number; // matched enhancements whose provisional/slate flags flipped
  unmatchedRepo: string[];
  // WS1a field-accuracy reconcile (upgrade_tag / max_targets / keywords).
  upgradeChanged: { id: string; from: boolean; to: boolean }[];
  maxTargetsChanged: { id: string; from: number; to: number }[];
  // Keyword fields are FILL-ONLY: written only when the repo authored nothing, so a
  // finer authored restriction (a unit keyword the dump's army-level group omits) is
  // never destroyed. A populated authored value that disagrees is surfaced, not written.
  exclusionFilled: { id: string; to: string[] }[];
  exclusionReview: { id: string; authored: string[]; derived: string[] }[];
  restrictionsFilled: { id: string; to: string[] }[];
  attachmentBodyguardsChanged: { id: string; from: string[] | null; to: string[] | null }[];
  restrictionGroupsChanged: { id: string; from: string[][] | null; to: string[][] | null }[];
  /** Populated authored restrictions that differ from the dump (kept, review). `reason`
   *  is "multi-group-or" (flat list can't hold the OR) or "differs" (authored is finer). */
  restrictionsReview: { id: string; authored: string[] | null; derived: string[]; reason: string }[];
  /** Dump keyword ids that did not resolve to a repo label (skipped, not written). */
  unresolvedKeywords: { id: string; ids: string[] }[];
}

export interface EnhReport {
  dirs: DirEnhResult[];
  seeded: { dir: string; id: string; name: string; detachment_id: string }[];
  seedSkipped: { id: string; reason: string }[];
  newInDump: string[];
  cpExcluded: string[]; // CP-only dump enhancement ids held back from newInDump (default)
  staged: StagedWrite[];
}



/**
 * Strip a trailing parenthetical tag the dump appends to enhancement names
 * (" (Upgrade)", " (Aura)", " (Psychic)").
 *
 * The canonical repo name now KEEPS this tag (the RAW GW form) — GW's own data and
 * every downstream roster exporter carry it, and `normalizeName` treats `(` `)` as
 * ordinary characters, so a repo name that strips the tag fails to match an imported
 * roster line (`enhancement-unresolved`). `buildEnhCanon`, `buildEnhFieldCanon`, the
 * seeder, and the golden (`enhIdsByDir`) therefore all slug the RAW dump name.
 *
 * This helper survives only as the *stable base key* for the id migration
 * (`normalizeEnhancementNames`): the parenthetical-stripped base is invariant across
 * the rename, so it matches a repo enhancement to its dump row whether the committed
 * id is still the old stripped form or already the RAW one (idempotent).
 */
export function cleanEnhName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Enhancement repo-id → canon base points cost, from the dump. Combat-Patrol
 *  enhancements carry a null `basePointsCost` (CP has no enhancement points), so
 *  the value is `number | null` and callers must not overwrite an authored cost
 *  with null. */
export function buildEnhCanon(dump: MfmDump): Map<string, number | null> {
  const detName = dump.byId("detachment");
  const m = new Map<string, number | null>();
  for (const e of dump.table("enhancement")) {
    const en = dump.enName(e);
    const dn = dump.enName(detName.get(e.detachmentId));
    if (!en || !dn) continue;
    try {
      m.set(detachmentScopedId(en, dn), e.basePointsCost);
    } catch {
      /* unsluggable — skip */
    }
  }
  return m;
}

/** groupBy that tolerates a focused fixture omitting the table (returns empty). */
function safeGroupBy<N extends MfmTableName, K extends MfmStringKey<N>>(
  dump: MfmDump,
  name: N,
  key: K,
): ReadonlyMap<string, readonly MfmRow<N>[]> {
  return dump.tables[name] ? dump.groupBy(name, key) : new Map<string, readonly MfmRow<N>[]>();
}

/** Sorted-array equality treating null/undefined as the empty list. */
function sameLabels(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameGroups(
  a: readonly (readonly string[])[] | null | undefined,
  b: readonly (readonly string[])[] | null | undefined,
): boolean {
  const canonical = (groups: readonly (readonly string[])[] | null | undefined): string[] =>
    (groups ?? [])
      .map((group) => JSON.stringify([...group].sort((x, y) => x.localeCompare(y))))
      .sort((x, y) => x.localeCompare(y));
  return sameLabels(canonical(a), canonical(b));
}

/** Structured enhancement fields the dump can supply beyond cost. */
export interface EnhFields {
  upgrade_tag: boolean;
  max_targets: number;
  /** Resolved exclusion keyword labels, or null when the dump lists none. */
  exclusion_keywords: string[] | null;
  /** Resolved required-keyword restriction labels, or null when the dump lists none. */
  keyword_restrictions: string[] | null;
  /** Exact required-keyword groups: AND within each group, OR across groups. */
  keyword_restriction_groups: string[][] | null;
  /** Extra bodyguard datasheets the enhancement permits its bearer to join. */
  attachment_bodyguard_ids: string[] | null;
  /** True when >1 required-keyword group carries a different member set. */
  keywordRestrictionsAmbiguous: boolean;
  /** Dump keyword/faction-keyword ids that did not resolve to a repo label. */
  unresolvedKeywordIds: string[];
}

/**
 * Enhancement repo-id → structured fields, from the dump. Keyed identically to
 * {@link buildEnhCanon} (`detachmentScopedId(cleanEnhName, detachment)`) so a
 * matched repo enhancement's fields line up with its cost.
 *
 *   - upgrade_tag           ← enhancementType === "upgrade" (11e upgrade class)
 *   - max_targets           ← limit (how many copies may be taken; default 1)
 *   - exclusion_keywords    ← enhancement_excluded_keyword.keywordId → labels
 *   - keyword_restrictions  ← required-keyword-group keyword + faction-keyword members
 *
 * Required-keyword groups model "bearer must have keyword(s)". Every non-empty
 * source group becomes one conjunction in `keyword_restriction_groups`, including
 * a datasheet name when the group is datasheet-scoped. The groups are alternatives
 * (OR). The legacy flat union remains available for compatibility with authored
 * records, but cannot faithfully encode divergent alternatives.
 */
export function buildEnhFieldCanon(dump: MfmDump): Map<string, EnhFields> {
  const detName = dump.byId("detachment");
  const excludedByEnh = safeGroupBy(dump, "enhancement_excluded_keyword", "enhancementId");
  const groupsByEnh = safeGroupBy(dump, "enhancement_required_keyword_group", "enhancementId");
  const kwByGroup = safeGroupBy(dump, "enhancement_required_keyword_group_keyword", "enhancementRequiredKeywordGroupId");
  const fkwByGroup = safeGroupBy(dump, "enhancement_required_keyword_group_faction_keyword", "enhancementRequiredKeywordGroupId");
  const attachmentGroupsByEnh = safeGroupBy(dump, "enhancement_bodyguard_group", "enhancementId");
  const attachmentDatasheetsByGroup = safeGroupBy(
    dump,
    "enhancement_bodyguard_group_datasheet",
    "enhancementBodyguardGroupId",
  );

  const out = new Map<string, EnhFields>();
  for (const e of dump.table("enhancement")) {
    const en = dump.enName(e);
    const dn = dump.enName(detName.get(e.detachmentId));
    if (!en || !dn) continue;
    let id: string;
    try {
      id = detachmentScopedId(en, dn);
    } catch {
      continue; // unsluggable — skip
    }

    const unresolved: string[] = [];
    const exclusion_keywords = keywordLabels(
      dump,
      (excludedByEnh.get(e.id) ?? []).map((r) => r.keywordId),
      unresolved,
    );

    const datasheetById = dump.tables.datasheet ? dump.byId("datasheet") : undefined;
    const groupSets: string[][] = [];
    for (const g of groupsByEnh.get(e.id) ?? []) {
      const members = new Set<string>();
      for (const r of kwByGroup.get(g.id) ?? []) {
        const label = keywordLabel(dump, r.keywordId);
        if (label) members.add(label);
        else unresolved.push(r.keywordId);
      }
      for (const r of fkwByGroup.get(g.id) ?? []) {
        const label = factionKeywordLabel(dump, r.factionKeywordId);
        if (label) members.add(label);
        else unresolved.push(r.factionKeywordId);
      }
      // A datasheet-scoped group names the specific unit the enhancement (usually a
      // wargear upgrade) attaches to; the repo authors that datasheet name as a
      // restriction keyword (e.g. "Exorcist"). Include it so a FILL of an empty field
      // carries the unit specificity, not just the army keyword.
      if (g.datasheetId) {
        const dsName = dump.enName(datasheetById?.get(g.datasheetId));
        if (dsName) members.add(dsName);
        else unresolved.push(g.datasheetId);
      }
      if (members.size) groupSets.push([...members].sort((a, b) => a.localeCompare(b)));
    }
    const distinctGroupSets = [...new Map(groupSets.map((s) => [JSON.stringify(s), s])).values()];
    const union = [...new Set(distinctGroupSets.flat())].sort((a, b) => a.localeCompare(b));
    const attachmentBodyguardIds = new Set<string>();
    for (const group of attachmentGroupsByEnh.get(e.id) ?? []) {
      for (const relation of attachmentDatasheetsByGroup.get(group.id) ?? []) {
        const dsName = dump.enName(datasheetById?.get(relation.datasheetId));
        if (dsName) attachmentBodyguardIds.add(nameToId(dsName));
        else unresolved.push(relation.datasheetId);
      }
    }

    out.set(id, {
      upgrade_tag: e.enhancementType === "upgrade",
      max_targets: typeof e.limit === "number" ? e.limit : 1,
      exclusion_keywords,
      keyword_restrictions: union.length ? union : null,
      keyword_restriction_groups: distinctGroupSets.length ? distinctGroupSets : null,
      attachment_bodyguard_ids: attachmentBodyguardIds.size
        ? [...attachmentBodyguardIds].sort((a, b) => a.localeCompare(b))
        : null,
      keywordRestrictionsAmbiguous: distinctGroupSets.length > 1,
      unresolvedKeywordIds: [...new Set(unresolved)],
    });
  }
  return out;
}

/**
 * Repo-ids of the dump's Combat-Patrol-box enhancements. These are intentionally
 * not authored in the repo (mirroring how `seed-units`/`dispositions` hold back
 * Combat-Patrol content), so they are filtered out of `newInDump` by default.
 * Id'd exactly as `buildEnhCanon` keys its canon so the ids line up.
 */
export function combatPatrolEnhIds(dump: MfmDump): Set<string> {
  const detName = dump.byId("detachment");
  const ids = new Set<string>();
  for (const e of dump.table("enhancement")) {
    if (!e.isCombatPatrol) continue;
    const en = dump.enName(e);
    const dn = dump.enName(detName.get(e.detachmentId));
    if (!en || !dn) continue;
    try {
      ids.add(detachmentScopedId(en, dn));
    } catch {
      /* unsluggable — skip */
    }
  }
  return ids;
}

/** Outcome of the RAW-name id migration (`normalizeEnhancementNames`). */
export interface EnhNormResult {
  staged: StagedWrite[];
  /** Distinct old enhancement id → new RAW id (the share-registry alias set). */
  renames: Record<string, string>;
  /** Rows whose display name changed — id renames *and* id-stable casing fixes. */
  nameChanges: { id: string; from: string; to: string }[];
  /** Detachment `enhancement_ids` references rewritten old → new. */
  refRewrites: { dir: string; detachment_id: string; from: string; to: string }[];
  /** Dump bases that resolved to >1 RAW id — ambiguous, left untouched, surfaced. */
  collisions: string[];
}

/**
 * Migrate authored enhancement names + ids to the RAW GW form (keep the trailing
 * " (Upgrade)"/" (Aura)"/" (Psychic)" tag), and rewrite every detachment
 * `enhancement_ids` reference to the renamed id. This is the import-correct
 * representation: an imported roster line carries the tag and `normalizeName`
 * keeps parentheses, so a stripped repo name never resolves.
 *
 * Matching is by the parenthetical-stripped *base* (`cleanEnhName` scoped to the
 * detachment), which is invariant across the rename — so the pass is idempotent:
 * on already-RAW data every base still resolves to the same id/name and nothing is
 * staged. Only enhancements the dump knows are touched; hand-authored/CP-only
 * entries the dump lacks are left alone.
 */
export function normalizeEnhancementNames(dump: MfmDump): EnhNormResult {
  const detName = dump.byId("detachment");
  // Stripped scoped base id → { RAW scoped id, RAW en name }.
  const baseMap = new Map<string, { newId: string; newName: string }>();
  const collided = new Set<string>();
  for (const e of dump.table("enhancement")) {
    const en = dump.enName(e);
    const dn = dump.enName(detName.get(e.detachmentId));
    if (!en || !dn) continue;
    let base: string;
    let rawId: string;
    try {
      base = detachmentScopedId(cleanEnhName(en), dn);
      rawId = detachmentScopedId(en, dn);
    } catch {
      continue; // unsluggable — skip
    }
    const prev = baseMap.get(base);
    if (prev && prev.newId !== rawId) collided.add(base);
    else baseMap.set(base, { newId: rawId, newName: en });
  }
  for (const b of collided) baseMap.delete(b);

  const renames: Record<string, string> = {};
  const nameChanges: EnhNormResult["nameChanges"] = [];
  const staged: StagedWrite[] = [];

  // Pass 1 — enhancements: rename id + set RAW name.
  for (const dir of [...repoDirs()].sort()) {
    const p = path.join(CORE_DIR, dir, "enhancements.json");
    if (!fs.existsSync(p)) continue;
    const enhs = readJsonArray<EnhRecord>(p);
    let touched = false;
    for (const e of enhs) {
      const det = (e.detachment_id as string | undefined) ?? "";
      if (!det) continue;
      const base = `${nameToId(cleanEnhName(e.name))}-${det}`;
      const hit = baseMap.get(base);
      if (!hit) continue;
      if (e.id !== hit.newId) {
        renames[e.id] = hit.newId;
        e.id = hit.newId;
        touched = true;
      }
      if (e.name !== hit.newName) {
        nameChanges.push({ id: hit.newId, from: e.name, to: hit.newName });
        e.name = hit.newName;
        touched = true;
      }
    }
    if (touched) staged.push({ path: p, value: enhs });
  }

  // Pass 2 — detachments: rewrite enhancement_ids references through the rename map.
  const refRewrites: EnhNormResult["refRewrites"] = [];
  for (const dir of [...repoDirs()].sort()) {
    const p = path.join(CORE_DIR, dir, "detachments.json");
    if (!fs.existsSync(p)) continue;
    const dets = readJsonArray<{ id: string; enhancement_ids?: string[] }>(p);
    let touched = false;
    for (const det of dets) {
      if (!Array.isArray(det.enhancement_ids)) continue;
      det.enhancement_ids = det.enhancement_ids.map((eid) => {
        const nw = renames[eid];
        if (nw && nw !== eid) {
          refRewrites.push({ dir, detachment_id: det.id, from: eid, to: nw });
          touched = true;
          return nw;
        }
        return eid;
      });
    }
    if (touched) staged.push({ path: p, value: dets });
  }

  return { staged, renames, nameChanges, refRewrites, collisions: [...collided].sort() };
}
export function runEnhancements(
  dump: MfmDump,
  write: boolean,
  opts: { includeCombatPatrol?: boolean } = {}
): EnhReport {
  const canon = buildEnhCanon(dump);
  const fieldCanon = buildEnhFieldCanon(dump);
  const matchedIds = new Set<string>();
  const dirs: DirEnhResult[] = [];
  const staged: StagedWrite[] = [];
  // CP enhancements carry the combat-patrol game mode so a reconcile of authored
  // Combat Patrol content keeps it filed on the non-competitive dimension.
  const cpIds = combatPatrolEnhIds(dump);
  const seeded: EnhReport["seeded"] = [];
  const seedSkipped: EnhReport["seedSkipped"] = [];
  const newInDump: string[] = [];
  const cpExcluded: string[] = [];
  const enhancementsByDir = new Map<string, EnhRecord[]>();
  const detachmentLocations = new Map<string, { dir: string; record: DetachmentRecord; path: string }[]>();
  const detachmentsByDir = new Map<string, DetachmentRecord[]>();
  for (const dir of [...repoDirs()].sort()) {
    const detPath = path.join(CORE_DIR, dir, "detachments.json");
    if (!fs.existsSync(detPath)) continue;
    const records = readJsonArray<DetachmentRecord>(detPath);
    detachmentsByDir.set(dir, records);
    for (const record of records) {
      const locations = detachmentLocations.get(record.id) ?? [];
      locations.push({ dir, record, path: detPath });
      detachmentLocations.set(record.id, locations);
    }
  }
  const touchedDetachmentPaths = new Set<string>();

  for (const dir of [...repoDirs()].sort()) {
    const p = path.join(CORE_DIR, dir, "enhancements.json");
    if (!fs.existsSync(p)) continue;
    const enhs = readJsonArray<EnhRecord>(p);
    enhancementsByDir.set(dir, enhs);
    const res: DirEnhResult = {
      dir,
      matched: 0,
      costChanged: [],
      confirmed: 0,
      unmatchedRepo: [],
      upgradeChanged: [],
      maxTargetsChanged: [],
      exclusionFilled: [],
      exclusionReview: [],
      restrictionsFilled: [],
      restrictionsReview: [],
      restrictionGroupsChanged: [],
      attachmentBodyguardsChanged: [],
      unresolvedKeywords: [],
    };
    for (const e of enhs) {
      const cost = canon.get(e.id);
      if (cost === undefined) {
        res.unmatchedRepo.push(e.id);
        continue;
      }
      matchedIds.add(e.id);
      res.matched++;
      // The dump carries no points cost for Combat-Patrol enhancements
      // (basePointsCost is null; CP has no enhancement points). Leave the authored
      // cost untouched (0 by convention) rather than overwriting it with null;
      // still reconcile game mode + confirm below.
      if (cost !== null) {
        if (e.cost !== cost) res.costChanged.push({ id: e.id, from: e.cost, to: cost });
      }
      const needsConfirm =
        e.points_provisional !== false ||
        e.game_version?.dataslate !== CONFIRMED.dataslate ||
        e.game_version?.edition !== CONFIRMED.edition;
      if (needsConfirm) res.confirmed++;
      // Mutate in-memory in BOTH modes; the dry-run rehearsal validates the result.
      if (cost !== null) e.cost = cost;
      e.points_provisional = false;
      if (e.game_version) {
        e.game_version.edition = CONFIRMED.edition;
        e.game_version.dataslate = CONFIRMED.dataslate;
      }
      if (cpIds.has(e.id)) e.game_modes = ["combat-patrol"];

      // WS1a field-accuracy reconcile. Mutate in BOTH modes; the dry run rehearses.
      const f = fieldCanon.get(e.id);
      if (f) {
        if ((e.upgrade_tag ?? false) !== f.upgrade_tag) {
          res.upgradeChanged.push({ id: e.id, from: e.upgrade_tag ?? false, to: f.upgrade_tag });
          e.upgrade_tag = f.upgrade_tag;
        }
        if ((e.max_targets ?? 1) !== f.max_targets) {
          res.maxTargetsChanged.push({ id: e.id, from: e.max_targets ?? 1, to: f.max_targets });
          e.max_targets = f.max_targets;
        }
        const groupsAuthored = e.keyword_restriction_groups ?? null;
        if (
          f.unresolvedKeywordIds.length === 0 &&
          !sameGroups(groupsAuthored, f.keyword_restriction_groups)
        ) {
          res.restrictionGroupsChanged.push({
            id: e.id,
            from: groupsAuthored,
            to: f.keyword_restriction_groups,
          });
          if (f.keyword_restriction_groups === null) delete e.keyword_restriction_groups;
          else e.keyword_restriction_groups = f.keyword_restriction_groups;
        }
        const attachmentAuthored = e.attachment_bodyguard_ids ?? null;
        if (!sameLabels(attachmentAuthored, f.attachment_bodyguard_ids)) {
          res.attachmentBodyguardsChanged.push({
            id: e.id,
            from: attachmentAuthored,
            to: f.attachment_bodyguard_ids,
          });
          if (f.attachment_bodyguard_ids === null) delete e.attachment_bodyguard_ids;
          else e.attachment_bodyguard_ids = f.attachment_bodyguard_ids;
        }
        // surface a populated disagreement rather than clobber an authored exclusion.
        const exclAuthored = e.exclusion_keywords ?? [];
        if (f.exclusion_keywords !== null) {
          if (exclAuthored.length === 0) {
            res.exclusionFilled.push({ id: e.id, to: f.exclusion_keywords });
            e.exclusion_keywords = f.exclusion_keywords;
          } else if (!sameLabels(exclAuthored, f.exclusion_keywords)) {
            res.exclusionReview.push({ id: e.id, authored: exclAuthored, derived: f.exclusion_keywords });
          }
        }
        // Preserve the legacy flat AND field for consumers that do not yet know the
        // OR groups. Never flatten several alternatives into one impossible AND.
        const restrAuthored = e.keyword_restrictions ?? [];
        if (f.keyword_restrictions !== null && !f.keywordRestrictionsAmbiguous) {
          if (restrAuthored.length === 0) {
            res.restrictionsFilled.push({ id: e.id, to: f.keyword_restrictions });
            e.keyword_restrictions = f.keyword_restrictions;
          } else if (!sameLabels(restrAuthored, f.keyword_restrictions)) {
            res.restrictionsReview.push({
              id: e.id,
              authored: restrAuthored,
              derived: f.keyword_restrictions,
              reason: "differs",
            });
          }
        }
        if (f.unresolvedKeywordIds.length) res.unresolvedKeywords.push({ id: e.id, ids: f.unresolvedKeywordIds });
      }
    }
    staged.push({ path: p, value: enhs });
    dirs.push(res);
  }
  for (const source of dump.table("enhancement")) {
    const name = dump.enName(source);
    const sourceDetachment = dump.byId("detachment").get(source.detachmentId);
    const detachmentName = dump.enName(sourceDetachment);
    if (!name || !detachmentName) continue;
    let id: string;
    let detachmentId: string;
    try {
      id = detachmentScopedId(name, detachmentName);
      detachmentId = nameToId(detachmentName);
    } catch {
      continue;
    }
    if (matchedIds.has(id)) continue;
    if (!opts.includeCombatPatrol && cpIds.has(id)) {
      cpExcluded.push(id);
      continue;
    }
    if (source.basePointsCost === null) {
      seedSkipped.push({ id, reason: "matched-play enhancement has no points cost" });
      continue;
    }

    const sourceDirs = new Set<string>();
    if (dump.tables.publication && dump.tables.faction_keyword) {
      const ownFactionId = sourceDetachment?.id
        ? dump.factionKeywordOfDetachment(sourceDetachment.id)
        : null;
      const ownFaction = ownFactionId
        ? factionKeywordLabel(dump, ownFactionId)
        : null;
      const ownDir = repoDirForFactionName(ownFaction ?? undefined);
      if (ownDir) sourceDirs.add(ownDir);
    }
    if (
      sourceDetachment?.id &&
      dump.tables.detachment_faction_keyword &&
      dump.tables.publication &&
      dump.tables.faction_keyword
    ) {
      for (const keyword of requiredKeywordsForDetachment(dump, sourceDetachment.id) ?? []) {
        const dir = repoDirForFactionName(keyword);
        if (dir) sourceDirs.add(dir);
      }
    }
    const allLocations = detachmentLocations.get(detachmentId) ?? [];
    const routed = allLocations.filter((location) => sourceDirs.has(location.dir));
    const locations = routed.length > 0 ? routed : allLocations;
    if (locations.length !== 1) {
      seedSkipped.push({
        id,
        reason: locations.length === 0
          ? `detachment ${detachmentId} has no repo entity`
          : `detachment ${detachmentId} is ambiguous across ${locations.map((location) => location.dir).join(", ")}`,
      });
      continue;
    }

    const location = locations[0];
    const fields = fieldCanon.get(id);
    if (!fields) {
      seedSkipped.push({ id, reason: "structured enhancement fields did not resolve" });
      continue;
    }
    if (fields.unresolvedKeywordIds.length > 0) {
      seedSkipped.push({
        id,
        reason: `eligibility keyword ids did not resolve: ${fields.unresolvedKeywordIds.join(", ")}`,
      });
      continue;
    }
    const record: EnhRecord = {
      id,
      name,
      detachment_id: detachmentId,
      cost: source.basePointsCost,
      ability_id: null,
      is_unique: true,
      game_version: { ...CONFIRMED },
      points_provisional: false,
      upgrade_tag: fields.upgrade_tag,
      max_targets: fields.max_targets,
    };
    if (fields.keyword_restriction_groups) {
      record.keyword_restriction_groups = fields.keyword_restriction_groups;
      if (!fields.keywordRestrictionsAmbiguous && fields.keyword_restrictions) {
        record.keyword_restrictions = fields.keyword_restrictions;
      }
    }
    if (fields.exclusion_keywords) record.exclusion_keywords = fields.exclusion_keywords;
    if (fields.attachment_bodyguard_ids) {
      record.attachment_bodyguard_ids = fields.attachment_bodyguard_ids;
    }

    const enhancements = enhancementsByDir.get(location.dir);
    if (!enhancements) {
      seedSkipped.push({ id, reason: `enhancements.json is absent in ${location.dir}` });
      continue;
    }
    enhancements.push(record);
    matchedIds.add(id);
    const refs = location.record.enhancement_ids ?? [];
    if (!refs.includes(id)) {
      refs.push(id);
      location.record.enhancement_ids = refs;
      touchedDetachmentPaths.add(location.path);
    }
    seeded.push({ dir: location.dir, id, name, detachment_id: detachmentId });
  }
  for (const detachmentPath of [...touchedDetachmentPaths].sort()) {
    const dir = path.basename(path.dirname(detachmentPath));
    staged.push({ path: detachmentPath, value: detachmentsByDir.get(dir) });
  }

  const unmatched = [...canon.keys()].filter((id) => !matchedIds.has(id));
  for (const id of unmatched) {
    if (!cpExcluded.includes(id)) newInDump.push(id);
  }
  newInDump.sort();
  cpExcluded.sort();
  seeded.sort((a, b) => a.dir.localeCompare(b.dir) || a.id.localeCompare(b.id));
  seedSkipped.sort((a, b) => a.id.localeCompare(b.id));
  return { dirs, newInDump, cpExcluded, seeded, seedSkipped, staged };
}

export function buildEnhReport(report: EnhReport, write: boolean): string {
  const { dirs, seeded, seedSkipped, newInDump, cpExcluded } = report;
  const sum = (f: (d: DirEnhResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const L: string[] = [];
  L.push(`# MFM enhancement reconcile — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Reconciles source-owned fields and seeds source-complete matched-play");
  L.push("enhancements whose detachment already exists. `keyword_restriction_groups`");
  L.push("preserves exact OR-of-AND eligibility. `exclusion_keywords` and the legacy");
  L.push("flat `keyword_restrictions` remain fill-only. Prose is never read or written.");
  L.push("");
  L.push("| Dir | Matched | Cost | upgrade | max_tgt | groups | excl-fill | excl-rev | restr-fill | restr-rev | Repo-only |");
  L.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const d of dirs.filter((d) => d.matched || d.unmatchedRepo.length)) {
    L.push(
      `| ${d.dir} | ${d.matched} | ${d.costChanged.length} | ${d.upgradeChanged.length} | ${d.maxTargetsChanged.length} | ${d.restrictionGroupsChanged.length} | ${d.exclusionFilled.length} | ${d.exclusionReview.length} | ${d.restrictionsFilled.length} | ${d.restrictionsReview.length} | ${d.unmatchedRepo.length} |`
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.matched)}** | **${sum((d) => d.costChanged.length)}** | **${sum((d) => d.upgradeChanged.length)}** | **${sum((d) => d.maxTargetsChanged.length)}** | **${sum((d) => d.restrictionGroupsChanged.length)}** | **${sum((d) => d.exclusionFilled.length)}** | **${sum((d) => d.exclusionReview.length)}** | **${sum((d) => d.restrictionsFilled.length)}** | **${sum((d) => d.restrictionsReview.length)}** | **${sum((d) => d.unmatchedRepo.length)}** |`
  );
  L.push("");
  for (const d of dirs) {
    const hasDetail =
      d.costChanged.length ||
      d.upgradeChanged.length ||
      d.maxTargetsChanged.length ||
      d.restrictionGroupsChanged.length ||
      d.exclusionFilled.length ||
      d.exclusionReview.length ||
      d.restrictionsFilled.length ||
      d.restrictionsReview.length ||
      d.unresolvedKeywords.length ||
      d.unmatchedRepo.length;
    if (!hasDetail) continue;
    L.push(`## ${d.dir}`);
    if (d.costChanged.length) {
      L.push("", "**Cost changes** (old → new):");
      d.costChanged.forEach((c) => L.push(`- ${c.id}: ${c.from} → ${c.to}`));
    }
    if (d.upgradeChanged.length) {
      L.push("", "**upgrade_tag changes:**");
      d.upgradeChanged.forEach((c) => L.push(`- ${c.id}: ${c.from} → ${c.to}`));
    }
    if (d.maxTargetsChanged.length) {
      L.push("", "**max_targets changes:**");
      d.maxTargetsChanged.forEach((c) => L.push(`- ${c.id}: ${c.from} → ${c.to}`));
    }
    if (d.restrictionGroupsChanged.length) {
      L.push("", "**keyword_restriction_groups changes:**");
      d.restrictionGroupsChanged.forEach((c) =>
        L.push(`- ${c.id}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`),
      );
    }
    if (d.exclusionFilled.length) {
      L.push("", "**exclusion_keywords filled:**");
      d.exclusionFilled.forEach((c) => L.push(`- ${c.id}: [${c.to.join(", ")}]`));
    }
    if (d.restrictionsFilled.length) {
      L.push("", "**keyword_restrictions filled:**");
      d.restrictionsFilled.forEach((c) => L.push(`- ${c.id}: [${c.to.join(", ")}]`));
    }
    if (d.exclusionReview.length) {
      L.push("", "**exclusion_keywords — authored differs from dump (kept, REVIEW):**");
      d.exclusionReview.forEach((c) =>
        L.push(`- ${c.id}: authored [${c.authored.join(", ")}] vs dump [${c.derived.join(", ")}]`),
      );
    }
    if (d.restrictionsReview.length) {
      L.push("", "**keyword_restrictions — authored kept, REVIEW:**");
      d.restrictionsReview.forEach((c) =>
        L.push(`- ${c.id} (${c.reason}): authored [${(c.authored ?? []).join(", ")}] vs dump-union [${c.derived.join(", ")}]`),
      );
    }
    if (d.unresolvedKeywords.length) {
      L.push("", "**Unresolved dump keyword ids (skipped):**");
      d.unresolvedKeywords.forEach((c) => L.push(`- ${c.id}: ${c.ids.join(", ")}`));
    }
    if (d.unmatchedRepo.length) {
      L.push("", "**Repo enhancements absent from dump** (left as-is):");
      d.unmatchedRepo.forEach((id) => L.push(`- ${id}`));
    }
    L.push("");
  }
  if (seeded.length) {
    L.push(`## Seeded matched-play enhancements (${seeded.length})`, "");
    seeded.forEach((entry) =>
      L.push(`- ${entry.dir}/${entry.id} (${entry.name}) → ${entry.detachment_id}`),
    );
    L.push("");
  }
  if (seedSkipped.length) {
    L.push(`## Enhancement seeds skipped (${seedSkipped.length})`, "");
    seedSkipped.forEach((entry) => L.push(`- ${entry.id}: ${entry.reason}`));
    L.push("");
  }
  if (newInDump.length) {
    L.push("## Unresolved enhancements in dump (no unambiguous repo detachment)");
    L.push("");
    newInDump.slice(0, 200).forEach((s) => L.push(`- ${s}`));
    if (newInDump.length > 200) L.push(`- …and ${newInDump.length - 200} more`);
    L.push("");
  }
  if (cpExcluded.length) {
    L.push(
      `## Combat-Patrol enhancements held back (${cpExcluded.length} — pass --include-combat-patrol to author)`
    );
    L.push("");
    cpExcluded.slice(0, 200).forEach((s) => L.push(`- ${s}`));
    if (cpExcluded.length > 200) L.push(`- …and ${cpExcluded.length - 200} more`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
