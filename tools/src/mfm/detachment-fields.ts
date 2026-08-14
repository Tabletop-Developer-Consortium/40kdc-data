/**
 * detachment-fields.ts — WS2: reconcile detachment entity fields against the GW
 * MFM dump. Two structured fields the dump is authoritative for, both fill-only
 * and non-destructive (mirroring the enhancement / faction reconciles):
 *
 *   - restrictions.required_keywords ← detachment_faction_keyword (applicability)
 *   - tags                           ← detachment_unique_keyword (mutual-exclusivity)
 *   - detachment_rule_ids            ← detachment_rule (named rule → ability link)
 *
 * ── detachment_rule_ids: structural rule-ability association ──
 * detachment_rule lists the named rule(s) a detachment carries. The rule PROSE is
 * authored enrichment (DSL / raw-text store) and never enters this repo; only the
 * structural id LINK is dump-derived here. Each dump rule display name is slugged
 * with {@link nameToId} (the same bare-id form the authored rule abilities use,
 * e.g. "Warp Rifts" → `warp-rifts`) and reconciled against the detachment's authored
 * `detachment_rule_id` (deprecated singular) + `detachment_rule_ids`. A link is only
 * ever WRITTEN when its slug resolves to an ability already authored in the dir's
 * enrichment — an unresolved id would fail `integrity.ts`, and inventing the ability
 * from the dump would import prose we must not. So the projection is honestly
 * PARTIAL: detachments whose rule ability is not yet authored (mostly the new 11e
 * Space Marine chapter detachments) are surfaced as an authoring worklist, not
 * filled. Authored links that disagree with the dump slug (an ad-hoc scoped id, or
 * a rule the repo has not linked) are surfaced for review, never overwritten.
 *
 * The derivation helpers ({@link requiredKeywordsForDetachment},
 * {@link tagsForDetachment}) are pure and are ALSO consumed by the matched-play
 * seeder ({@link seed-detachments}) so a freshly-seeded chapter-locked detachment
 * carries the same fields this reconcile would maintain on the next dump upload —
 * the "permanent" half of the fill: seeder creates, reconcile maintains.
 *
 * ── required_keywords: the applicability-vs-ownership discriminator ──
 * detachment_faction_keyword lists every faction keyword that MAY take a detachment.
 * For a roster-wide detachment (Gladius Task Force) that list is the ownership
 * keyword ("Adeptus Astartes") PLUS every sub-faction — an enumeration of "everyone
 * qualifies", NOT a restriction. For a chapter-locked detachment (Hammer of Avernii)
 * the list is exactly the locking keyword(s) ("Iron Hands") and OMITS the ownership
 * keyword. So applicability is a genuine required-keyword restriction *iff the
 * ownership keyword is absent from it* — the clean rule that separates the 7
 * chapter-locked detachments from the 259 unrestricted ones in the current dump.
 *
 * ── tags: mutual-exclusivity keyword ──
 * detachment_unique_keyword is GW's "you may include at most one detachment carrying
 * this keyword" grouping (two detachments sharing "Battlesuit" ⇒ only one per army).
 * The repo stores it as a lowercase slug (nameToId of the label), matching authored
 * data ("armoury", "lions", "reverend").
 *
 * IP: reads only ids and English keyword display names. No rules/lore prose.
 */
import * as fs from "fs";
import * as path from "path";
import { nameToId } from "../converters/id-generator.js";
import { MfmDump } from "./loader.js";
import { CORE_DIR, ENRICHMENT_DIR, readJsonArray } from "./repo-files.js";
import { repoDirForFactionName, repoDirs } from "./faction-map.js";
import { keywordLabel, factionKeywordLabel } from "./keywords.js";
import type { StagedWrite } from "./apply.js";

export interface DetachmentRestrictions {
  required_keywords?: string[];
  excluded_keywords?: string[];
  notes?: string;
}

export interface DetachmentAuthorityTarget {
  tags?: string[];
  restrictions?: DetachmentRestrictions | null;
}

interface DetRecord {
  id: string;
  name: string;
  faction_id: string;
  tags?: string[];
  detachment_rule_id?: string | null;
  detachment_rule_ids?: string[] | null;
  restrictions?: DetachmentRestrictions | null;
  [k: string]: unknown;
}

/**
 * Required-keyword labels for a detachment, or null when it is not sub-faction
 * locked. The applicability list is a genuine restriction only when it NARROWS
 * eligibility below the owning roster (see file header):
 *   - ownership keyword present in the list ⇒ roster-wide enumeration of who
 *     qualifies (all of them), not a restriction ⇒ null;
 *   - otherwise keep only applicability keywords NARROWER than the roster — drop
 *     any label that is the detachment's own roster/home keyword (its slug equals
 *     the routed dir) or the ownership keyword. Requiring the roster keyword is
 *     trivially satisfied by every unit in the army (e.g. "Aeldari" over an
 *     Asuryani-owned Aeldari detachment), so a purely-roster list ⇒ null.
 * `unresolved` collects any faction-keyword id that did not resolve to a label.
 */
export function requiredKeywordsForDetachment(
  dump: MfmDump,
  detId: string,
  unresolved?: string[],
): string[] | null {
  const ownFk = dump.factionKeywordOfDetachment(detId);
  const ownName = ownFk ? factionKeywordLabel(dump, ownFk) : null;
  const dir = repoDirForFactionName(ownName ?? undefined);
  const edges = dump.children("detachment_faction_keyword.detachmentId", detId);
  const labels: string[] = [];
  for (const e of edges) {
    const label = factionKeywordLabel(dump, e.factionKeywordId);
    if (label) labels.push(label);
    else if (unresolved) unresolved.push(e.factionKeywordId);
  }
  if (labels.length === 0) return null;
  // Ownership keyword present ⇒ roster-wide enumeration, not a restriction.
  if (ownName && labels.includes(ownName)) return null;
  // Ownership absent: a genuine lock keeps only labels narrower than the roster.
  // Drop the roster/home keyword (slug == dir) and the owner itself — requiring
  // the roster keyword restricts nothing.
  const narrowing = [...new Set(labels)].filter(
    (l) => l !== ownName && !(dir && nameToId(l) === dir),
  );
  if (narrowing.length === 0) return null;
  return narrowing.sort((a, b) => a.localeCompare(b));
}

/**
 * Mutual-exclusivity `tags` (lowercase slugs) for a detachment, from its unique
 * keywords. Empty array when the dump lists none. `unresolved` collects any
 * keyword id that did not resolve to a label.
 */
export function tagsForDetachment(dump: MfmDump, detId: string, unresolved?: string[]): string[] {
  const edges = dump.children("detachment_unique_keyword.detachmentId", detId);
  const tags = new Set<string>();
  for (const e of edges) {
    const label = keywordLabel(dump, e.keywordId);
    if (label) tags.add(nameToId(label));
    else if (unresolved) unresolved.push(e.keywordId);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * Bare slug ids for a detachment's dump rule(s) — one `nameToId` per
 * `detachment_rule` row's English display name, sorted and de-duplicated. This is
 * the same bare-id form the authored rule abilities use (`ability_id`), so it can be
 * reconciled directly against `detachment_rule_id`/`detachment_rule_ids`. A name that
 * cannot slug (throws the entity-id pattern) is skipped. Reads only ids and display
 * names — never rule prose.
 */
export function ruleIdsForDetachment(dump: MfmDump, detId: string): string[] {
  const ids = new Set<string>();
  for (const r of dump.children("detachment_rule.detachmentId", detId)) {
    const name = dump.enName(r);
    if (!name) continue;
    try {
      ids.add(nameToId(name));
    } catch {
      /* name that cannot form a valid entity id (e.g. all-punctuation) — skip */
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** The authored links a detachment already carries (deprecated singular ∪ plural). */
function authoredRuleLinks(det: DetRecord): string[] {
  const s = new Set<string>();
  if (det.detachment_rule_id) s.add(det.detachment_rule_id);
  for (const id of det.detachment_rule_ids ?? []) s.add(id);
  return [...s].sort((a, b) => a.localeCompare(b));
}

/**
 * Ability ids (`ability_id ?? id`) authored in a dir's enrichment, cached per dir.
 * Used to gate a rule-link FILL: only a slug that already resolves to an authored
 * ability may be written (an unresolved id fails `integrity.ts`, and the rule prose
 * is authored separately, never minted from the dump). Missing file ⇒ empty set.
 */
function makeAbilityIdLoader(): (dir: string) => Set<string> {
  const cache = new Map<string, Set<string>>();
  return (dir: string): Set<string> => {
    const hit = cache.get(dir);
    if (hit) return hit;
    const p = path.join(ENRICHMENT_DIR, dir, "abilities.json");
    const set = new Set<string>();
    if (fs.existsSync(p)) {
      for (const a of readJsonArray<{ id?: string; ability_id?: string }>(p)) {
        const aid = a.ability_id ?? a.id;
        if (aid) set.add(aid);
      }
    }
    cache.set(dir, set);
    return set;
  };
}

/**
 * Repo detachment-id → dump detachment UUID, per repo dir. A dump detachment is
 * registered under EVERY dir the repo might file it in: its publication-ownership
 * dir AND — when it is chapter-locked — each chapter dir named by its required
 * keyword(s). The repo files a chapter-locked detachment (e.g. Hammer of Avernii,
 * owned by Adeptus Astartes but locked to Iron Hands) under the CHAPTER dir
 * (`iron-hands/`), not the ownership dir, so ownership-only routing would never
 * reach it to fill its required_keywords/tags. Slug derivation mirrors
 * `buildCanon`/`dispositions` so ids line up; first observed wins on a collision.
 */
function dumpDetIdByRepoId(dump: MfmDump): Map<string, Map<string, string>> {
  const byDir = new Map<string, Map<string, string>>();
  const register = (dir: string, slug: string, detId: string): void => {
    const m = byDir.get(dir) ?? new Map<string, string>();
    if (!m.has(slug)) m.set(slug, detId);
    byDir.set(dir, m);
  };
  for (const det of dump.table("detachment")) {
    const name = dump.enName(det);
    if (!det.id || !name) continue;
    let slug: string;
    try {
      slug = nameToId(name);
    } catch {
      continue;
    }
    const ownFk = dump.factionKeywordOfDetachment(det.id);
    const ownDir = repoDirForFactionName((ownFk ? factionKeywordLabel(dump, ownFk) : undefined) ?? undefined);
    if (ownDir) register(ownDir, slug, det.id);
    // Chapter-lock: also register under each required-keyword's chapter dir.
    for (const kw of requiredKeywordsForDetachment(dump, det.id) ?? []) {
      const chapterDir = repoDirForFactionName(kw);
      if (chapterDir && chapterDir !== ownDir) register(chapterDir, slug, det.id);
    }
  }
  return byDir;
}

export interface DirDetFieldResult {
  dir: string;
  matched: number;
  tagsChanged: { id: string; from: string[]; to: string[] }[];
  tagsConfirmed: number;
  reqChanged: { id: string; from: string[]; to: string[] }[];
  reqConfirmed: number;
  ruleFilled: { id: string; to: string[] }[];
  ruleConfirmed: number;
  ruleReview: { id: string; authored: string[]; derived: string[] }[];
  ruleUnauthored: { id: string; derived: string[] }[];
  unresolvedKeywords: { id: string; ids: string[] }[];
}

export interface DetFieldsReport {
  dirs: DirDetFieldResult[];
  staged: StagedWrite[];
}

/** Sorted-array equality treating null/undefined as the empty list. */
function same(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
export function applyAuthoritativeDetachmentFields(
  detachment: DetachmentAuthorityTarget,
  tags: readonly string[],
  requiredKeywords: readonly string[],
): { tagsChanged: boolean; requiredKeywordsChanged: boolean } {
  const tagsChanged = !same(detachment.tags, tags);
  if (tagsChanged) detachment.tags = [...tags];

  const requiredKeywordsChanged = !same(
    detachment.restrictions?.required_keywords,
    requiredKeywords,
  );
  if (requiredKeywordsChanged) {
    detachment.restrictions = {
      ...(detachment.restrictions ?? {}),
      required_keywords: [...requiredKeywords],
    };
  }
  return { tagsChanged, requiredKeywordsChanged };
}


export function runDetachmentFields(dump: MfmDump): DetFieldsReport {
  const detIdByRepoId = dumpDetIdByRepoId(dump);
  const abilityIds = makeAbilityIdLoader();
  const dirs: DirDetFieldResult[] = [];
  const staged: StagedWrite[] = [];

  for (const dir of [...repoDirs()].sort()) {
    const p = path.join(CORE_DIR, dir, "detachments.json");
    if (!fs.existsSync(p)) continue;
    const dets = readJsonArray<DetRecord>(p);
    const idMap = detIdByRepoId.get(dir);
    const res: DirDetFieldResult = {
      dir,
      matched: 0,
      tagsChanged: [],
      tagsConfirmed: 0,
      reqChanged: [],
      reqConfirmed: 0,
      ruleFilled: [],
      ruleConfirmed: 0,
      ruleReview: [],
      ruleUnauthored: [],
      unresolvedKeywords: [],
    };
    let changed = false;

    for (const det of dets) {
      const detId = idMap?.get(det.id);
      if (!detId) continue;
      res.matched++;
      const unresolved: string[] = [];

      // Dump-derived tags and required keywords are authoritative. Replace stale
      // values and clear them when the source derives none.
      const tags = tagsForDetachment(dump, detId, unresolved);
      const tagsAuthored = [...(det.tags ?? [])];
      const req = requiredKeywordsForDetachment(dump, detId, unresolved) ?? [];
      const reqAuthored = [...(det.restrictions?.required_keywords ?? [])];
      const authority = applyAuthoritativeDetachmentFields(det, tags, req);
      if (authority.tagsChanged) {
        res.tagsChanged.push({ id: det.id, from: tagsAuthored, to: tags });
        changed = true;
      } else {
        res.tagsConfirmed++;
      }
      if (authority.requiredKeywordsChanged) {
        res.reqChanged.push({ id: det.id, from: reqAuthored, to: req });
        changed = true;
      } else {
        res.reqConfirmed++;
      }

      // detachment_rule_ids — structural link, FILL-ONLY and resolve-gated. Only
      // slugs that already resolve to an authored ability may be written (an
      // unresolved id would fail integrity; the rule prose is authored separately).
      // Authored links that disagree with the dump are surfaced; a detachment whose
      // rule ability is not yet authored is an authoring worklist entry, not a fill.
      const derivedRules = ruleIdsForDetachment(dump, detId);
      if (derivedRules.length > 0) {
        const authoredRules = authoredRuleLinks(det);
        if (authoredRules.length === 0) {
          const resolvable = derivedRules.filter((id) => abilityIds(dir).has(id));
          if (resolvable.length > 0) {
            det.detachment_rule_ids = resolvable;
            res.ruleFilled.push({ id: det.id, to: resolvable });
            changed = true;
          }
          // Any dump rule with no authored ability (all of them when nothing was
          // resolvable) is the authoring worklist — surfaced, never invented.
          const unauthored = derivedRules.filter((id) => !abilityIds(dir).has(id));
          if (unauthored.length > 0) res.ruleUnauthored.push({ id: det.id, derived: unauthored });
        } else if (same(authoredRules, derivedRules)) {
          res.ruleConfirmed++;
        } else {
          res.ruleReview.push({ id: det.id, authored: authoredRules, derived: derivedRules });
        }
      }

      if (unresolved.length) res.unresolvedKeywords.push({ id: det.id, ids: [...new Set(unresolved)] });
    }

    if (changed) staged.push({ path: p, value: dets });
    dirs.push(res);
  }

  return { dirs, staged };
}

export function buildDetFieldsReport(report: DetFieldsReport, write: boolean): string {
  const { dirs } = report;
  const sum = (f: (d: DirDetFieldResult) => number) => dirs.reduce((a, d) => a + f(d), 0);
  const L: string[] = [];
  L.push(`# MFM detachment fields — ${write ? "APPLIED" : "DRY RUN"}`);
  L.push("");
  L.push("Authoritative reconcile of `tags` (mutual-exclusivity unique keyword → slug)");
  L.push("and `restrictions.required_keywords` (chapter-lock applicability keyword).");
  L.push("`detachment_rule_ids` remains resolve-gated and fill-only. Rule prose is");
  L.push("authored separately and is untouched.");
  L.push("");
  L.push("| Dir | Matched | tags-chg | tags-ok | req-chg | req-ok | rule-fill | rule-ok | rule-rev | rule-unauth |");
  L.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const d of dirs.filter((d) => d.matched)) {
    if (
      !d.tagsChanged.length && !d.tagsConfirmed &&
      !d.reqChanged.length && !d.reqConfirmed &&
      !d.ruleFilled.length && !d.ruleConfirmed && !d.ruleReview.length && !d.ruleUnauthored.length
    )
      continue;
    L.push(
      `| ${d.dir} | ${d.matched} | ${d.tagsChanged.length} | ${d.tagsConfirmed} | ${d.reqChanged.length} | ${d.reqConfirmed} | ${d.ruleFilled.length} | ${d.ruleConfirmed} | ${d.ruleReview.length} | ${d.ruleUnauthored.length} |`,
    );
  }
  L.push(
    `| **TOTAL** | **${sum((d) => d.matched)}** | **${sum((d) => d.tagsChanged.length)}** | **${sum((d) => d.tagsConfirmed)}** | **${sum((d) => d.reqChanged.length)}** | **${sum((d) => d.reqConfirmed)}** | **${sum((d) => d.ruleFilled.length)}** | **${sum((d) => d.ruleConfirmed)}** | **${sum((d) => d.ruleReview.length)}** | **${sum((d) => d.ruleUnauthored.length)}** |`,
  );
  L.push("");
  for (const d of dirs) {
    const details: string[] = [];
    d.tagsChanged.forEach((c) => details.push(`- tags changed ${c.id}: [${c.from.join(", ")}] -> [${c.to.join(", ")}]`));
    d.reqChanged.forEach((c) => details.push(`- required_keywords changed ${c.id}: [${c.from.join(", ")}] -> [${c.to.join(", ")}]`));
    d.ruleFilled.forEach((c) => details.push(`- detachment_rule_ids filled ${c.id}: [${c.to.join(", ")}]`));
    d.ruleReview.forEach((c) => details.push(`- detachment_rule_ids REVIEW ${c.id}: authored [${c.authored.join(", ")}] vs dump [${c.derived.join(", ")}]`));
    d.ruleUnauthored.forEach((c) => details.push(`- detachment_rule_ids UNAUTHORED ${c.id}: dump rule(s) [${c.derived.join(", ")}] have no authored ability yet`));
    d.unresolvedKeywords.forEach((c) => details.push(`- unresolved keyword ids ${c.id}: ${c.ids.join(", ")}`));
    if (details.length) L.push(`## ${d.dir}`, ...details, "");
  }
  return L.join("\n") + "\n";
}
