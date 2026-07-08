/**
 * Native list-builder logic — pure functions over the embedded dataset twin.
 *
 * The builder holds a `BuilderState` (a Roster-shaped working draft) entirely
 * client-side; nothing here touches Rust. On save it lowers to a canonical
 * `Roster` and `exportRoster(…, "roster-json")` produces the text the app
 * imports through its normal pipeline (wh40kdc ≥ 0.5.6 round-trips roster-json).
 *
 * Annotation-first: points and `validateLoadout` violations are *reported*,
 * never enforced — the caller shows them as chips and keeps Save enabled.
 */

import {
	baseLoadout,
	baseUnitPoints,
	clampWeaponCount,
	exportRoster,
	groupLoadout,
	pointsTierMissing,
	tryImportRoster,
	validateLoadout,
	weaponBounds,
	type AlliedRule,
	type Detachment,
	type Enhancement,
	type LoadoutGroup,
	type Roster,
	type ShareList,
	type Unit,
	type WargearOption,
	type WeaponBound,
} from '@alpaca-software/40kdc-data';

// Re-exported so the builder UI keeps a single import surface; the ordinal-aware
// pricing now lives in the package (see `unitOrdinals` for the army-copy index).
export { baseUnitPoints, pointsTierMissing };
import { ds } from '$lib/data/dataset';
import type { DatacardData } from '$lib/types/DatacardData';

/** Battle-size points ceilings (advisory — overrun only highlights). */
export const BATTLE_SIZE_LIMITS = {
	incursion: 1000,
	'strike-force': 2000,
} as const;
export type BattleSize = keyof typeof BATTLE_SIZE_LIMITS;

/** 11e detachment-point budgets per battle size. */
export const DETACHMENT_POINT_CAPS = {
	incursion: 2,
	'strike-force': 3,
} as const;

/** One unit in the working draft. `loadout` is weapon/wargear id → count. */
export interface BuilderUnit {
	/** Stable per-row key (units of the same datasheet can repeat). */
	key: string;
	datasheetId: string;
	/**
	 * Source faction of an *allied* unit, when it differs from the army faction.
	 * The same datasheet id can exist under several factions (e.g. a Daemon
	 * unit), so allied rows carry their source faction to resolve the right copy
	 * via `getInFaction`. Undefined for the army's own units (the default copy).
	 */
	factionId?: string;
	/** The allied-rule id this unit was included under, if it's an ally. */
	allyRuleId?: string;
	/**
	 * For a *leader*, the row key of the bodyguard unit it is attached to (11e
	 * attaches leaders at list-building time). Stored on the leader; a unit may
	 * host several leaders, a leader attaches to at most one unit. Undefined when
	 * the leader is unattached or the unit isn't a leader.
	 */
	attachedToKey?: string;
	/**
	 * Keywords the player has selected this unit to receive from a count-limited
	 * detachment grant (e.g. picking this War Dog as one of Houndpack Lance's
	 * three CHARACTER units). Stored as authored (e.g. `["Character"]`).
	 */
	selectedGrants?: string[];
	modelCount: number;
	loadout: Map<string, number>;
	enhancementId: string | null;
	isWarlord: boolean;
}

export interface BuilderState {
	name: string;
	factionId: string | null;
	/** Selected detachments (11e lists may field several under a DP cap). */
	detachmentIds: string[];
	battleSize: BattleSize;
	/**
	 * Event-chosen points ceiling that replaces the battle-size limit — set for
	 * each army of a Doubles team (the Doubles Companion fixes no level; events
	 * commonly play 500/750/1000 per player). Rules keyed by battle size (DP
	 * caps, ally points caps) band through {@link effectiveBattleSize}.
	 */
	pointsLimitOverride?: number | null;
	disposition: string | null;
	units: BuilderUnit[];
}

export function emptyBuilderState(): BuilderState {
	return {
		name: '',
		factionId: null,
		detachmentIds: [],
		battleSize: 'strike-force',
		disposition: null,
		units: [],
	};
}

// ── Dataset lookups ──────────────────────────────────────────────────────────

export function unitRaw(
	datasheetId: string,
	factionId?: string,
	armyFactionId?: string,
): Unit | undefined {
	// The same datasheet id can exist under several factions with different
	// faction_keywords (e.g. shared Chaos units like Chaos Spawn). Resolve the
	// faction-scoped copy: an allied unit's `factionId` wins; otherwise scope to
	// the army's own faction so own-army units don't fall back to whichever copy
	// happens to be registered first (which would carry the wrong keywords).
	const fid = factionId ?? armyFactionId;
	if (fid) {
		const scoped = ds.units.getInFaction(datasheetId, fid);
		if (scoped) return scoped.raw;
	}
	return ds.units.getAny(datasheetId)?.raw;
}

/**
 * Resolve a builder unit's datasheet, honouring its (possibly allied) faction.
 * `armyFactionId` scopes own-army units (those with no ally `factionId`) to the
 * army's faction; pass `state.factionId` / `draft.factionId` from the call site.
 */
export function buRaw(bu: BuilderUnit, armyFactionId?: string): Unit | undefined {
	return unitRaw(bu.datasheetId, bu.factionId, armyFactionId);
}

/** Units in a faction, sorted by name; empty when factionId is null. */
export function unitsForFaction(factionId: string | null): Unit[] {
	if (!factionId) return [];
	return ds.units
		.byFaction(factionId)
		.map((v) => v.raw)
		.filter((u) => !u.is_legend)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function detachmentsForFaction(factionId: string | null): Detachment[] {
	if (!factionId) return [];
	return ds.detachments.byFaction(factionId).slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a detachment by id, scoped to the army's faction. The shared Space
 * Marine detachments (e.g. `gladius-task-force`) are replicated under all 13
 * chapter factions and diverge per chapter (detachment_rule_id, stratagem_ids,
 * enhancement_ids, detachment_points), so a faction-less lookup returns the
 * wrong chapter's copy. Pass the army's `factionId`; `getAny` is the explicit
 * first-wins fallback when faction is genuinely unknown.
 */
export function detachmentRaw(id: string, factionId?: string): Detachment | undefined {
	return (factionId ? ds.detachments.getInFaction(id, factionId) : undefined) ?? ds.detachments.getAny(id);
}

/** DP cost of a detachment (1–3), or 0 when the entity records none. */
export function detachmentPointCost(detachmentId: string, factionId?: string): number {
	return detachmentRaw(detachmentId, factionId)?.detachment_points ?? 0;
}

/** Total DP spent by the selected detachments. */
export function totalDetachmentPoints(state: BuilderState): number {
	const fid = state.factionId ?? undefined;
	return state.detachmentIds.reduce((sum, id) => sum + detachmentPointCost(id, fid), 0);
}

/** The 11e detachment-point budget for the draft's effective battle size. */
export function detachmentPointCap(state: BuilderState): number {
	return DETACHMENT_POINT_CAPS[effectiveBattleSize(state)];
}

/** A detachment-tag carried by two or more selected detachments. */
export interface TagConflict {
	tag: string;
	detachmentNames: string[];
}

/**
 * Detachment-tag conflicts in the draft. 11e lets a roster field several
 * detachments under the DP cap, but only one of any given *type* — a detachment
 * may carry a `UNIQUE` tag (e.g. `dynasty`) and "cannot be taken with another
 * detachment of that tag". Returns one entry per tag shared by ≥2 selected
 * detachments, naming them in selection order (deterministic).
 */
export function detachmentTagConflicts(state: BuilderState): TagConflict[] {
	const byTag = new Map<string, string[]>();
	const fid = state.factionId ?? undefined;
	for (const id of state.detachmentIds) {
		const det = detachmentRaw(id, fid);
		if (!det) continue;
		for (const tag of det.tags ?? []) {
			const names = byTag.get(tag);
			if (names) names.push(det.name);
			else byTag.set(tag, [det.name]);
		}
	}
	const out: TagConflict[] = [];
	for (const [tag, detachmentNames] of byTag) {
		if (detachmentNames.length >= 2) out.push({ tag, detachmentNames });
	}
	return out;
}

/**
 * Enhancements legal for `unit` under any selected detachment: scoped to the
 * detachments, then filtered by the enhancement's keyword restrictions /
 * exclusions against the unit's *effective* keywords. Characters only — including
 * units granted CHARACTER by the detachment (pass `selected` = the unit's
 * `selectedGrants`, e.g. a chosen Houndpack War Dog). Deduped by id, preserving
 * detachment order.
 */
export function eligibleEnhancements(
	detachmentIds: string[],
	unit: Unit | undefined,
	selected: string[] = [],
	factionId?: string,
): Enhancement[] {
	if (detachmentIds.length === 0 || !unit) return [];
	const unitKeywords = effectiveKeywords(unit, detachmentIds, selected, factionId);
	if (!unitKeywords.has('character')) return [];
	const seen = new Set<string>();
	const out: Enhancement[] = [];
	for (const detachmentId of detachmentIds) {
		const det = detachmentRaw(detachmentId, factionId);
		if (!det) continue;
		for (const id of det.enhancement_ids ?? []) {
			if (seen.has(id)) continue;
			const e = ds.enhancements.get(id);
			if (!e) continue;
			const restrict = e.keyword_restrictions ?? [];
			if (restrict.length > 0 && !restrict.some((k) => unitKeywords.has(k.toLowerCase()))) {
				continue;
			}
			const exclude = e.exclusion_keywords ?? [];
			if (exclude.some((k) => unitKeywords.has(k.toLowerCase()))) continue;
			seen.add(id);
			out.push(e);
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Grouping & display (NR-style roster/picker) ───────────────────────────────

/** Battlefield-role buckets, plus an `other` catch-all for unroled datasheets. */
export type UnitRole =
	| 'epic-hero'
	| 'character'
	| 'battleline'
	| 'dedicated-transport'
	| 'fortification'
	| 'allied'
	| 'other';

/** Display order for role sections (matches a typical datasheet/army-list order). */
const ROLE_ORDER: UnitRole[] = [
	'epic-hero',
	'character',
	'battleline',
	'dedicated-transport',
	'fortification',
	'allied',
	'other',
];

const ROLE_LABELS: Record<UnitRole, string> = {
	'epic-hero': 'Epic Heroes',
	character: 'Characters',
	battleline: 'Battleline',
	'dedicated-transport': 'Dedicated Transports',
	fortification: 'Fortifications',
	allied: 'Allied',
	other: 'Other Units',
};

export function roleLabel(role: UnitRole): string {
	return ROLE_LABELS[role];
}

export function roleOf(unit: Unit): UnitRole {
	return (unit.role as UnitRole | undefined) ?? 'other';
}

/**
 * Broad unit-*type* keywords (Infantry/Vehicle/…), used both as a secondary facet
 * in the picker and to split the un-roled `other` bucket into legible sections.
 * These live in `Unit.keywords` alongside faction/role keywords; we surface only
 * the movement/type family so it stays a short, stable set. Order = section order.
 */
const UNIT_TYPE_KEYWORDS = [
	'Infantry',
	'Mounted',
	'Cavalry',
	'Beast',
	'Swarm',
	'Walker',
	'Vehicle',
	'Monster',
	'Aircraft',
	'Titanic',
] as const;

/** This unit's recognised type keywords, in canonical order (may be empty). */
export function unitTypeKeywords(unit: Unit): string[] {
	const have = new Set((unit.keywords ?? []).map((k) => k.toLowerCase()));
	return UNIT_TYPE_KEYWORDS.filter((k) => have.has(k.toLowerCase()));
}

/**
 * A roster/picker section: a battlefield role, except the un-roled `other` bucket
 * splits by unit type (Infantry/Beast/Vehicle/…) so it isn't one undifferentiated
 * lump. `key` is the stable section id; `order` drives display order.
 */
export interface Section {
	key: string;
	label: string;
	order: number;
}

const ROLE_INDEX: Record<UnitRole, number> = Object.fromEntries(
	ROLE_ORDER.map((r, i) => [r, i]),
) as Record<UnitRole, number>;

/** The section a unit belongs to (its role, or its type when un-roled). */
export function sectionOf(unit: Unit): Section {
	const role = roleOf(unit);
	if (role !== 'other') {
		return { key: role, label: ROLE_LABELS[role], order: ROLE_INDEX[role] };
	}
	// Un-roled: split by the unit's primary type keyword.
	const type = unitTypeKeywords(unit)[0];
	const otherBase = ROLE_INDEX.other;
	if (!type) {
		return { key: 'other', label: ROLE_LABELS.other, order: otherBase + UNIT_TYPE_KEYWORDS.length };
	}
	const typeIdx = UNIT_TYPE_KEYWORDS.indexOf(type as (typeof UNIT_TYPE_KEYWORDS)[number]);
	return { key: `other:${type.toLowerCase()}`, label: type, order: otherBase + typeIdx };
}

export interface UnitGroup extends Section {
	units: Unit[];
}

/** Picker units bucketed into sections, in `order`, names sorted within. */
export function groupUnitsByRole(units: Unit[]): UnitGroup[] {
	const buckets = new Map<string, UnitGroup>();
	for (const u of units) {
		const s = sectionOf(u);
		const bucket = buckets.get(s.key);
		if (bucket) bucket.units.push(u);
		else buckets.set(s.key, { ...s, units: [u] });
	}
	return [...buckets.values()]
		.sort((a, b) => a.order - b.order)
		.map((g) => ({ ...g, units: g.units.sort((a, b) => a.name.localeCompare(b.name)) }));
}

export interface DraftGroup extends Section {
	units: BuilderUnit[];
	points: number;
}

/**
 * Roster units bucketed into sections with per-section points subtotals. Insertion
 * order is preserved *within* a section (roster order is user-meaningful).
 */
export function groupDraftByRole(state: BuilderState): DraftGroup[] {
	const armyFaction = state.factionId ?? undefined;
	const ordinals = unitOrdinals(state.units);
	const buckets = new Map<string, { section: Section; units: BuilderUnit[] }>();
	for (const bu of state.units) {
		const raw = buRaw(bu, armyFaction);
		const s: Section = raw
			? sectionOf(raw)
			: { key: 'other', label: ROLE_LABELS.other, order: ROLE_INDEX.other + UNIT_TYPE_KEYWORDS.length };
		const bucket = buckets.get(s.key);
		if (bucket) bucket.units.push(bu);
		else buckets.set(s.key, { section: s, units: [bu] });
	}
	return [...buckets.values()]
		.sort((a, b) => a.section.order - b.section.order)
		.map(({ section, units }) => ({
			...section,
			units,
			points: units.reduce((sum, u) => sum + unitPoints(u, armyFaction, ordinals.get(u.key)), 0),
		}));
}

/**
 * Clone a configured unit: same datasheet/model-count/loadout/enhancement, fresh key,
 * warlord dropped (exactly one warlord). The loadout Map is copied, never aliased.
 */
export function cloneBuilderUnit(bu: BuilderUnit, key: string): BuilderUnit {
	return { ...bu, key, loadout: new Map(bu.loadout), isWarlord: false };
}

/**
 * One-line summary of what a unit has *equipped* (every loadout id with count>0),
 * for the collapsed roster row — the actual weapons, not just the optional picks.
 */
export function loadoutSummary(bu: BuilderUnit): string {
	return [...bu.loadout.entries()]
		.filter(([, count]) => count > 0)
		.map(([id, count]) => ({ name: itemName(id), count }))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(({ name, count }) => (count > 1 ? `${count}× ${name}` : name))
		.join(', ');
}

/**
 * Repair a loadout against the unit's bounds: fixed weapons (min===max — e.g. a
 * base weapon every model carries) are set to that required count, others are
 * clamped into range. Used when seeding from an import, which can under-record
 * always-on base weapons and leave them flagged "below min" with no way to fix.
 */
export function reconcileLoadout(
	datasheetId: string,
	modelCount: number,
	loadout: Map<string, number>,
	factionId?: string,
): Map<string, number> {
	const unit = unitRaw(datasheetId, factionId);
	if (!unit) return new Map(loadout);
	const bounds = weaponBounds(unit, modelCount, ds.wargearOptionsOf(unit), unitModels(unit));
	const next = new Map(loadout);
	for (const [id, b] of bounds) {
		if (b.min === b.max) {
			if (b.max > 0) next.set(id, b.max);
			else next.delete(id);
		} else {
			next.set(id, clampWeaponCount(bounds, id, next.get(id) ?? 0));
		}
	}
	return next;
}

/**
 * Change a unit's model count while PRESERVING its wargear. Clamps the requested
 * count into the datasheet's [min,max] range, then reconciles the existing loadout
 * against the new bounds (keeps the player's swaps, clamps counts that now exceed
 * the new max, tops up always-on base weapons). Mirrors what adding a unit and
 * importing a roster already do via {@link reconcileLoadout} — the model-count
 * stepper must NOT reset selections to the datasheet default.
 */
export function withModelCount(
	bu: BuilderUnit,
	requested: number,
	armyFactionId?: string,
): BuilderUnit {
	const range = buRaw(bu, armyFactionId)?.model_count ?? null;
	const min = range?.min ?? 1;
	const max = range?.max ?? Math.max(min, requested);
	const next = Math.min(max, Math.max(min, requested));
	const loadout = reconcileLoadout(bu.datasheetId, next, bu.loadout, bu.factionId ?? armyFactionId);
	return { ...bu, modelCount: next, loadout };
}

/**
 * Project a builder unit onto the `DatacardData` the shared `Datacard` component
 * renders: the equipped weapon ids split into ranged/melee (a weapon is ranged
 * when any profile has a numeric range — the same test `Datacard` uses). Lets the
 * builder's right panel show the selected unit's live datacard.
 */
export function builderUnitToDatacardData(bu: BuilderUnit, armyFactionId?: string): DatacardData {
	const unit = buRaw(bu, armyFactionId);
	const equipped = [...bu.loadout.entries()].filter(([, c]) => c > 0).map(([id]) => id);
	const ranged: string[] = [];
	const melee: string[] = [];
	for (const id of equipped) {
		const w = (armyFactionId ? ds.weapons.getInFaction(id, armyFactionId) : undefined) ?? ds.weapons.getAny(id);
		const isRanged = !!w && w.raw.profiles.some((p) => typeof p.range === 'number');
		(isRanged ? ranged : melee).push(id);
	}
	return {
		unit_name: unit?.name ?? bu.datasheetId,
		player: 'Attacker',
		datasheet_id: bu.datasheetId,
		// Stamp the resolved faction so the (id-only) Datacard renders the right
		// copy of a shared chassis instead of falling back to first-wins.
		faction_id: unit?.faction_id ?? null,
		ranged_weapon_ids: ranged,
		melee_weapon_ids: melee,
		loadout_raw_names: equipped.map((id) => itemName(id)),
	};
}

// ── Points ───────────────────────────────────────────────────────────────────

/**
 * 1-based army ordinal of each unit among those sharing its `datasheetId`, in
 * army order. 11e prices some datasheets by how many copies you have taken
 * (`unit.points` ordinal bands), so the Nth copy of a datasheet may cost more
 * than the first — see {@link baseUnitPoints}. Keyed by `BuilderUnit.key`.
 */
export function unitOrdinals(units: readonly BuilderUnit[]): Map<string, number> {
	const seen = new Map<string, number>();
	const out = new Map<string, number>();
	for (const u of units) {
		const n = (seen.get(u.datasheetId) ?? 0) + 1;
		seen.set(u.datasheetId, n);
		out.set(u.key, n);
	}
	return out;
}

/**
 * Points for a unit at `modelCount` taken as its `ordinal`-th army copy: the
 * ordinal-aware cost tier (see {@link baseUnitPoints}) plus the chosen
 * enhancement's cost. Returns 0 for the base when no tier covers the count
 * (caller surfaces a violation rather than guessing). `ordinal` defaults to the
 * 1st copy; whole-army callers pass the real ordinal via {@link unitOrdinals}.
 */
export function unitPoints(bu: BuilderUnit, armyFactionId?: string, ordinal = 1): number {
	const unit = buRaw(bu, armyFactionId);
	if (!unit) return 0;
	const base = baseUnitPoints(unit, bu.modelCount, ordinal);
	const enh = bu.enhancementId ? (ds.enhancements.get(bu.enhancementId)?.cost ?? 0) : 0;
	return base + enh;
}

export function totalPoints(state: BuilderState): number {
	const armyFaction = state.factionId ?? undefined;
	const ordinals = unitOrdinals(state.units);
	return state.units.reduce((sum, u) => sum + unitPoints(u, armyFaction, ordinals.get(u.key)), 0);
}

export function pointsLimit(state: BuilderState): number {
	return state.pointsLimitOverride ?? BATTLE_SIZE_LIMITS[state.battleSize];
}

/**
 * Cheapest cost to add one more copy of `unit` to the current list — its
 * smallest points tier evaluated at the ordinal it would enter the army (copies
 * of its datasheet already present + 1). Ordinal-aware so the 3rd Chaos
 * Terminators shows its real next cost. Mirrors `candidateAffordability`'s
 * cheapest-next-copy in the package's `data/affordability.ts`.
 */
export function nextCopyCost(state: BuilderState, unit: Unit, armyFactionId?: string): number {
	const resolved = unitRaw(unit.id, unit.faction_id, armyFactionId ?? state.factionId ?? undefined) ?? unit;
	const tiers = resolved.points ?? [];
	if (tiers.length === 0) return 0;
	const copies = state.units.filter((u) => u.datasheetId === unit.id).length;
	const nextOrdinal = copies + 1;
	return Math.min(...tiers.map((t) => baseUnitPoints(resolved, t.models, nextOrdinal)));
}

/**
 * Whether the current list can fit one more copy of `unit` under its points
 * limit. Advisory — the builder treats over-limit as a soft warning, not a hard
 * block — so callers use this to grey/annotate, not to forbid the add.
 */
export function canAfford(state: BuilderState, unit: Unit, armyFactionId?: string): boolean {
	return totalPoints(state) + nextCopyCost(state, unit, armyFactionId) <= pointsLimit(state);
}

/**
 * The battle size whose size-keyed restrictions apply. With a points override
 * (a Doubles army), "rules that have restrictions based on the size of the
 * army are based on the points limit of that individual player's army" — so
 * the override picks its band: ≤1000 plays under Incursion-band caps.
 */
export function effectiveBattleSize(state: BuilderState): BattleSize {
	if (state.pointsLimitOverride == null) return state.battleSize;
	return state.pointsLimitOverride <= BATTLE_SIZE_LIMITS.incursion ? 'incursion' : 'strike-force';
}

// ── Loadout ───────────────────────────────────────────────────────────────────

/**
 * The composition model rows for a unit (count ranges + recorded
 * `default_weapon_ids`), passed to the loadout maths so the authoritative base
 * loadout is used when present. Matched by `unit_id`; the recorded defaults are
 * the same across a shared chassis's faction views.
 */
function unitModels(unit: Unit) {
	return ds.unitCompositions.find((c) => c.unit_id === unit.id)?.models;
}

/**
 * Default loadout for a freshly-added unit: the base (legal, no-swap) set — each
 * model carries its base weapons, no options applied. The take-every-swap
 * maximal set is illegal as a default (it stacks every swap at once), so the
 * unit starts at its datasheet-default configuration and the player opts into
 * swaps.
 */
export function defaultLoadout(unit: Unit, modelCount: number): Map<string, number> {
	const options = ds.wargearOptionsOf(unit);
	return baseLoadout(unit, modelCount, options, unitModels(unit)).counts;
}

/**
 * Wargear options for a datasheet, scoped to its faction so a shared chassis
 * resolves the right copy. Pass the allied `factionId` and/or the army's
 * `armyFactionId` exactly as {@link unitRaw} expects.
 */
export function wargearOptionsFor(
	datasheetId: string,
	factionId?: string,
	armyFactionId?: string,
): WargearOption[] {
	const unit = unitRaw(datasheetId, factionId, armyFactionId);
	return unit ? ds.wargearOptionsOf(unit) : [];
}

/** Inclusive [min,max] count range per weapon/wargear id, for stepper bounds. */
export function loadoutBounds(bu: BuilderUnit, armyFactionId?: string): Map<string, WeaponBound> {
	const unit = buRaw(bu, armyFactionId);
	if (!unit) return new Map();
	return weaponBounds(unit, bu.modelCount, ds.wargearOptionsOf(unit), unitModels(unit));
}

/**
 * The per-model-type loadout groups for a unit (for grouped "Nx <model>: …"
 * export), or `null` when the loadout doesn't decompose exactly (single model, no
 * recorded per-model defaults, or an indivisible bag). Mirrors {@link loadoutBounds}.
 */
export function loadoutGroups(bu: BuilderUnit, armyFactionId?: string): LoadoutGroup[] | null {
	const unit = buRaw(bu, armyFactionId);
	if (!unit) return null;
	return groupLoadout(unit, bu.modelCount, ds.wargearOptionsOf(unit), unitModels(unit), bu.loadout);
}

/** Clamp a requested count for one weapon id into its valid range. */
export function clampCount(
	bounds: Map<string, WeaponBound>,
	id: string,
	requested: number,
): number {
	return clampWeaponCount(bounds, id, requested);
}

/** Display name for a weapon/wargear id. */
export function itemName(id: string): string {
	return ds.weapons.getAny(id)?.name ?? ds.wargear.get(id)?.name ?? id;
}

/** Display name for an enhancement id (falls back to the id when unknown). */
export function enhancementName(id: string): string {
	return ds.enhancements.get(id)?.name ?? id;
}

/** Loadout-rule violations for a builder unit (empty = legal). */
export function loadoutViolations(bu: BuilderUnit, armyFactionId?: string) {
	const unit = buRaw(bu, armyFactionId);
	if (!unit) return [];
	return validateLoadout(unit, bu.modelCount, ds.wargearOptionsOf(unit), bu.loadout, unitModels(unit));
}

// ── Allies ("soup") ────────────────────────────────────────────────────────────

/** A valid-allies pool: an allied rule and the eligible units it grants. */
export interface AllyGroup {
	rule: AlliedRule;
	/** Panel heading (the rule's `label`, falling back to its name). */
	label: string;
	units: Unit[];
}

/**
 * The ally pools offered for the draft's faction and selected detachments — one
 * group per allied rule whose gates pass, each carrying its eligible units. This
 * is the data behind the "valid allies" panel; especially load-bearing for soup
 * factions (Chaos Knights, the Chaos cults, Genestealer Cults).
 */
export function alliesForState(state: BuilderState): AllyGroup[] {
	if (!state.factionId) return [];
	return ds.alliesFor(state.factionId, state.detachmentIds).map((rule) => ({
		rule,
		label: rule.label ?? rule.name,
		units: ds.allyUnitsFor(rule.id).map((v) => v.raw),
	}));
}

/** The combined-points cap an allied rule imposes at a battle size, or null. */
export function allyPointsLimit(rule: AlliedRule, battleSize: BattleSize): number | null {
	return (rule.points_limits ?? []).find((l) => l.battle_size === battleSize)?.max_points ?? null;
}

/** Lowercased union of a unit's `keywords` and `faction_keywords`. */
function keywordSet(unit: Unit): Set<string> {
	return new Set(
		[...(unit.keywords ?? []), ...(unit.faction_keywords ?? [])].map((k) => k.toLowerCase()),
	);
}

/** The four Chaos gods, in canonical (board-order) sequence. */
const CHAOS_GODS = ['Khorne', 'Tzeentch', 'Nurgle', 'Slaanesh'] as const;

/** A god-keyed slice of an ally pool. `god` is null for a pool with no god dimension. */
export interface GodBucket {
	/** The god label ('Khorne'…'Slaanesh', 'Undivided'), or null when the pool has no gods. */
	god: string | null;
	units: Unit[];
}

/**
 * Split an ally pool into per-Chaos-god buckets for readability — Daemonic
 * Pact's Legiones Daemonica pool spans all four gods, and one flat "Daemons"
 * list is hard to scan. Units carrying a god keyword bucket under it (canonical
 * order); god-neutral daemons (Be'lakor, Soul Grinder, Furies…) fall into
 * "Undivided". A pool with no god keywords at all (CSM Damned, Astra Militarum,
 * Chaos Knights, Tyranids) returns a single `{ god: null }` bucket — the caller
 * renders that flat, with no sub-headers. Purely presentational; it never
 * changes which units a rule grants.
 */
export function groupAlliesByGod(units: Unit[]): GodBucket[] {
	const byGod = new Map<string, Unit[]>();
	const undivided: Unit[] = [];
	for (const u of units) {
		const kw = keywordSet(u);
		const god = CHAOS_GODS.find((g) => kw.has(g.toLowerCase()));
		if (god) {
			const bucket = byGod.get(god);
			if (bucket) bucket.push(u);
			else byGod.set(god, [u]);
		} else {
			undivided.push(u);
		}
	}
	const out: GodBucket[] = [];
	for (const g of CHAOS_GODS) {
		const us = byGod.get(g);
		if (us && us.length > 0) out.push({ god: g, units: us });
	}
	if (undivided.length > 0) {
		// With god buckets present, the rest are "Undivided"; with none, the whole
		// pool has no god dimension → a single null bucket the caller renders flat.
		out.push({ god: out.length > 0 ? 'Undivided' : null, units: undivided });
	}
	return out;
}

/**
 * Whether a unit matches a free-text picker query: a name substring match OR an
 * exact keyword match (so typing "Khorne" surfaces every Khorne unit, the
 * screenshot's `Keywords:` filter). Empty query matches everything.
 */
export function unitMatchesQuery(unit: Unit, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	if (unit.name.toLowerCase().includes(q)) return true;
	return keywordSet(unit).has(q);
}

// ── Leaders (11e list-time attachment) ───────────────────────────────────────────

/** Whether a datasheet is a Leader — it can attach to at least one bodyguard unit. */
export function isLeader(unit: Unit): boolean {
	return ds.bodyguardsAttachableFrom(unit.id).length > 0;
}

/**
 * Draft rows the given leader can attach to: rows whose datasheet is an eligible
 * bodyguard for the leader, excluding the leader's own row. Drives the detail
 * panel's "Attached to" picker.
 */
export function attachableBodyguards(state: BuilderState, leader: BuilderUnit): BuilderUnit[] {
	const eligible = new Set(ds.bodyguardsAttachableFrom(leader.datasheetId).map((v) => v.id));
	return state.units.filter((u) => u.key !== leader.key && eligible.has(u.datasheetId));
}

/** Leaders in the draft currently attached to the given bodyguard row. */
export function attachedLeaders(state: BuilderState, bodyguard: BuilderUnit): BuilderUnit[] {
	return state.units.filter((u) => u.attachedToKey === bodyguard.key);
}

// ── Effective keywords (detachment grants) ───────────────────────────────────────

/**
 * A unit's keywords plus any its selected detachments grant it, lowercased.
 * Blanket grants (no `max_selected`) apply to every matching unit (e.g. Houndpack
 * Lance grants Battleline to all War Dogs). Count-limited grants (`max_selected`,
 * e.g. the three War Dogs that become CHARACTER) apply only when the player has
 * picked this unit — pass `selected` (the unit's `selectedGrants`). Used for the
 * datasheet cap, Warlord eligibility, and enhancement eligibility.
 */
export function effectiveKeywords(
	unit: Unit,
	detachmentIds: string[],
	selected: string[] = [],
	factionId?: string,
): Set<string> {
	const have = keywordSet(unit);
	const picked = new Set(selected.map((k) => k.toLowerCase()));
	for (const id of detachmentIds) {
		for (const grant of detachmentRaw(id, factionId)?.granted_keywords ?? []) {
			if (!(grant.to_keywords ?? []).some((k) => have.has(k.toLowerCase()))) continue;
			// Count-limited grants require an explicit per-unit selection.
			if (grant.max_selected != null && !picked.has(grant.keyword.toLowerCase())) continue;
			have.add(grant.keyword.toLowerCase());
		}
	}
	return have;
}

/**
 * The count-limited keyword grants a unit is *eligible to receive* under the
 * selected detachments (e.g. CHARACTER for a War Dog under Houndpack Lance), each
 * with its selection cap. Drives the detail panel's "make Character" toggles.
 */
export interface SelectableGrant {
	keyword: string;
	maxSelected: number;
	detachmentName: string;
}
export function selectableGrantsFor(
	unit: Unit,
	detachmentIds: string[],
	factionId?: string,
): SelectableGrant[] {
	const have = keywordSet(unit);
	const out: SelectableGrant[] = [];
	for (const id of detachmentIds) {
		const det = detachmentRaw(id, factionId);
		for (const grant of det?.granted_keywords ?? []) {
			if (grant.max_selected == null) continue;
			if (!(grant.to_keywords ?? []).some((k) => have.has(k.toLowerCase()))) continue;
			out.push({ keyword: grant.keyword, maxSelected: grant.max_selected, detachmentName: det?.name ?? id });
		}
	}
	return out;
}

/** How many units in the draft have been selected to receive `keyword` from a grant. */
export function grantSelectionCount(state: BuilderState, keyword: string): number {
	const k = keyword.toLowerCase();
	return state.units.filter((u) => (u.selectedGrants ?? []).some((g) => g.toLowerCase() === k)).length;
}

// ── Warlord eligibility ──────────────────────────────────────────────────────────

/**
 * Whether a unit may be the army Warlord: an *effective* CHARACTER (innate or
 * granted, e.g. a selected Houndpack War Dog) that isn't barred by the ally rule
 * it was included under (`cannot_be_warlord`). The detail panel shows the Warlord
 * control only when this is true.
 */
export function canBeWarlord(
	bu: BuilderUnit,
	detachmentIds: string[] = [],
	armyFactionId?: string,
): boolean {
	const raw = buRaw(bu, armyFactionId);
	if (!raw) return false;
	if (!effectiveKeywords(raw, detachmentIds, bu.selectedGrants ?? [], armyFactionId).has('character')) return false;
	if (bu.allyRuleId && ds.alliedRules.get(bu.allyRuleId)?.cannot_be_warlord) return false;
	return true;
}

// ── Validation summary (advisory) ──────────────────────────────────────────────

export interface BuilderViolation {
	unitKey: string | null;
	message: string;
	/** `info` renders neutrally (team-coordination notes); default is `warn`. */
	severity?: 'warn' | 'info';
}

/**
 * Allied-rule advisory checks for every active ally pool: per-battle-size points
 * cap, unit-count cap, warlord/enhancement locks, the per-god Battleline ratio,
 * the army-wide keyword condition (every *own* model must qualify — allied units
 * are the granted exception), any host-Warlord-keyword requirement, per-keyword
 * count caps, and the per-datasheet Warlord allowlist.
 */
function allyViolations(state: BuilderState): BuilderViolation[] {
	const out: BuilderViolation[] = [];
	const armyFaction = state.factionId ?? undefined;
	const ordinals = unitOrdinals(state.units);
	for (const { rule, label } of alliesForState(state)) {
		const allyUnits = state.units.filter((u) => u.allyRuleId === rule.id);
		if (allyUnits.length === 0) continue;

		const cap = allyPointsLimit(rule, effectiveBattleSize(state));
		if (cap != null) {
			const spent = allyUnits.reduce((s, u) => s + unitPoints(u, armyFaction, ordinals.get(u.key)), 0);
			if (spent > cap) {
				out.push({ unitKey: null, message: `${label}: ${spent} allied pts over the ${cap} pt limit` });
			}
		}
		if (rule.max_units != null && allyUnits.length > rule.max_units) {
			out.push({
				unitKey: null,
				message: `${label}: ${allyUnits.length} allied units over the ${rule.max_units} allowed`,
			});
		}
		if (rule.cannot_be_warlord) {
			for (const u of allyUnits) {
				if (u.isWarlord) out.push({ unitKey: u.key, message: `${label}: allied units cannot be Warlord` });
			}
		}
		if (rule.cannot_take_enhancements) {
			for (const u of allyUnits) {
				if (u.enhancementId) {
					out.push({ unitKey: u.key, message: `${label}: allied units cannot take Enhancements` });
				}
			}
		}
		for (const kw of rule.battleline_ratio_keywords ?? []) {
			const lk = kw.toLowerCase();
			let bl = 0;
			let nonBl = 0;
			for (const u of allyUnits) {
				const raw = buRaw(u, armyFaction);
				if (!raw || !keywordSet(raw).has(lk)) continue;
				if (keywordSet(raw).has('battleline')) bl += 1;
				else nonBl += 1;
			}
			if (nonBl > bl) {
				out.push({ unitKey: null, message: `${label}: ${kw} non-Battleline (${nonBl}) exceeds Battleline (${bl})` });
			}
		}
		const armyAny = (rule.army_keywords_any ?? []).map((k) => k.toLowerCase());
		if (armyAny.length > 0) {
			for (const u of state.units) {
				if (u.allyRuleId) continue; // allied units are the granted exception
				const raw = buRaw(u, armyFaction);
				if (!raw) continue;
				if (!armyAny.some((k) => keywordSet(raw).has(k))) {
					out.push({
						unitKey: u.key,
						message: `${label}: every army model must have ${(rule.army_keywords_any ?? []).join(' or ')}`,
					});
				}
			}
		}
		if (rule.warlord_required_keyword) {
			const wk = rule.warlord_required_keyword.toLowerCase();
			const warlord = state.units.find((u) => u.isWarlord);
			const raw = warlord ? buRaw(warlord, armyFaction) : undefined;
			if (warlord && raw && !keywordSet(raw).has(wk)) {
				out.push({ unitKey: null, message: `${label}: Warlord must have ${rule.warlord_required_keyword}` });
			}
		}
		for (const lim of rule.keyword_limits ?? []) {
			if (lim.battle_size !== effectiveBattleSize(state)) continue;
			const lk = lim.keyword.toLowerCase();
			const count = allyUnits.filter((u) => {
				const raw = buRaw(u, armyFaction);
				return raw != null && keywordSet(raw).has(lk);
			}).length;
			if (count > lim.max_count) {
				out.push({
					unitKey: null,
					message: `${label}: ${count} ${lim.keyword} over the ${lim.max_count} allowed`,
				});
			}
		}
		const warlordAllow = rule.warlord_datasheet_ids ?? [];
		if (warlordAllow.length > 0) {
			const allowed = new Set(warlordAllow);
			for (const u of allyUnits) {
				if (u.isWarlord && !allowed.has(u.datasheetId)) {
					out.push({ unitKey: u.key, message: `${label}: only specific units may be Warlord` });
				}
			}
		}
	}
	return out;
}

/**
 * Core army-construction caps (advisory): datasheet-name limits (≤3 of a
 * datasheet, ≤6 for Battleline / Dedicated Transport), Enhancement rules (each
 * unique, none on Epic Heroes), and Epic Hero uniqueness.
 */
function constructionViolations(state: BuilderState): BuilderViolation[] {
	const out: BuilderViolation[] = [];
	const armyFaction = state.factionId ?? undefined;

	// Datasheet-name caps.
	const counts = new Map<string, { count: number; cap: number; name: string }>();
	for (const u of state.units) {
		const raw = buRaw(u, armyFaction);
		if (!raw) continue;
		// Effective keywords include detachment grants (e.g. Houndpack Lance makes
		// War Dogs Battleline → cap 6 instead of 3).
		const kw = effectiveKeywords(raw, state.detachmentIds, [], armyFaction);
		const cap = kw.has('battleline') || raw.role === 'dedicated-transport' ? 6 : 3;
		const e = counts.get(u.datasheetId);
		if (e) e.count += 1;
		else counts.set(u.datasheetId, { count: 1, cap, name: raw.name });
	}
	for (const { count, cap, name } of counts.values()) {
		if (count > cap) out.push({ unitKey: null, message: `${count}× ${name} (max ${cap} of a datasheet)` });
	}

	// Enhancements: each unique, none on Epic Heroes. (The old army-wide "max 3
	// Enhancements" cap was removed from the rules and is no longer enforced.)
	const enhUsed = state.units.flatMap((u) => (u.enhancementId ? [u.enhancementId] : []));
	const dupes = new Set(enhUsed.filter((id, i) => enhUsed.indexOf(id) !== i));
	for (const id of dupes) {
		out.push({ unitKey: null, message: `Enhancement '${ds.enhancements.get(id)?.name ?? id}' used more than once` });
	}
	for (const u of state.units) {
		if (u.enhancementId && buRaw(u, armyFaction)?.role === 'epic-hero') {
			out.push({ unitKey: u.key, message: 'Epic Heroes cannot take Enhancements' });
		}
	}

	// Epic Hero uniqueness.
	const epic = new Map<string, { count: number; name: string }>();
	for (const u of state.units) {
		const raw = buRaw(u, armyFaction);
		if (raw?.role !== 'epic-hero') continue;
		const e = epic.get(u.datasheetId);
		if (e) e.count += 1;
		else epic.set(u.datasheetId, { count: 1, name: raw.name });
	}
	for (const { count, name } of epic.values()) {
		if (count > 1) out.push({ unitKey: null, message: `${name} included ${count}× (Epic Heroes are unique)` });
	}

	// Count-limited detachment grants (e.g. Houndpack Lance: ≤3 CHARACTER War Dogs).
	const seenGrant = new Set<string>();
	for (const id of state.detachmentIds) {
		const det = detachmentRaw(id, armyFaction);
		for (const grant of det?.granted_keywords ?? []) {
			if (grant.max_selected == null || seenGrant.has(grant.keyword.toLowerCase())) continue;
			seenGrant.add(grant.keyword.toLowerCase());
			const picked = grantSelectionCount(state, grant.keyword);
			if (picked > grant.max_selected) {
				out.push({
					unitKey: null,
					message: `${det?.name ?? id}: ${picked} ${grant.keyword} selected (max ${grant.max_selected})`,
				});
			}
		}
	}

	// Detachment unit minimums (e.g. Houndpack Lance: 3+ WAR DOG units).
	for (const id of state.detachmentIds) {
		const det = detachmentRaw(id, armyFaction);
		for (const req of det?.unit_minimums ?? []) {
			const k = req.keyword.toLowerCase();
			const have = state.units.filter((u) => {
				const raw = buRaw(u, armyFaction);
				return raw ? effectiveKeywords(raw, state.detachmentIds, u.selectedGrants ?? [], armyFaction).has(k) : false;
			}).length;
			if (have < req.min) {
				out.push({
					unitKey: null,
					message: `${det?.name ?? id}: requires ${req.min}+ ${req.keyword} units (have ${have})`,
				});
			}
		}
	}

	return out;
}

/** Every advisory issue in the draft: points overrun, model-count, loadout. */
export function builderViolations(state: BuilderState): BuilderViolation[] {
	const out: BuilderViolation[] = [];
	const total = totalPoints(state);
	const limit = pointsLimit(state);
	if (total > limit) {
		out.push({ unitKey: null, message: `${total} pts over the ${limit} pt limit` });
	}
	const dp = totalDetachmentPoints(state);
	const dpCap = detachmentPointCap(state);
	if (dp > dpCap) {
		out.push({ unitKey: null, message: `${dp} DP over the ${dpCap} DP budget` });
	}
	for (const conflict of detachmentTagConflicts(state)) {
		out.push({
			unitKey: null,
			message: `only one ‘${conflict.tag}’ detachment allowed: ${conflict.detachmentNames.join(', ')}`,
		});
	}
	const armyFaction = state.factionId ?? undefined;
	const ordinals = unitOrdinals(state.units);
	for (const bu of state.units) {
		const unit = buRaw(bu, armyFaction);
		if (!unit) {
			out.push({ unitKey: bu.key, message: 'unresolved datasheet' });
			continue;
		}
		const mc = unit.model_count;
		if (mc && (bu.modelCount < mc.min || bu.modelCount > mc.max)) {
			out.push({
				unitKey: bu.key,
				message: `model count ${bu.modelCount} outside ${mc.min}–${mc.max}`,
			});
		}
		if (pointsTierMissing(unit, bu.modelCount, ordinals.get(bu.key))) {
			out.push({ unitKey: bu.key, message: 'no points cost for this model count' });
		}
		for (const v of loadoutViolations(bu, armyFaction)) {
			out.push({ unitKey: bu.key, message: v.message });
		}
	}
	// Exactly one warlord: every army must name one, and only one.
	const warlords = state.units.filter((u) => u.isWarlord).length;
	if (warlords > 1) out.push({ unitKey: null, message: `${warlords} warlords (pick one)` });
	else if (warlords === 0 && state.units.length > 0)
		out.push({ unitKey: null, message: 'no Warlord set — every army must name one' });
	// Allied-rule limits and core army-construction caps (advisory).
	out.push(...allyViolations(state), ...constructionViolations(state));
	return out;
}

// ── Export ─────────────────────────────────────────────────────────────────────

/** Build a resolved ref from a known dataset id + display name. */
function ref(id: string, name: string) {
	return { id, raw_name: name, resolved: true, candidates: [] };
}

/**
 * Lower the draft to a canonical `Roster`. ids/names come straight from the
 * dataset (the builder only picks real entities), so every ref is resolved.
 * `resolve` re-derives ids on re-import; emitting them here keeps the exported
 * text self-describing.
 */
export function builderToRoster(state: BuilderState): Roster {
	const armyFaction = state.factionId ?? undefined;
	const factionName = state.factionId
		? (ds.factions.get(state.factionId)?.name ?? state.factionId)
		: null;
	const detachments = state.detachmentIds.map((id) => {
		const det = detachmentRaw(id, armyFaction);
		return { ref: ref(id, det?.name ?? id), dp_cost: det?.detachment_points ?? null };
	});

	const byKey = new Map(state.units.map((u) => [u.key, u]));
	const ordinals = unitOrdinals(state.units);
	const units = state.units.map((bu) => {
		const unit = buRaw(bu, armyFaction);
		const name = unit?.name ?? bu.datasheetId;
		const enh = bu.enhancementId ? ds.enhancements.get(bu.enhancementId) : undefined;
		const weaponRef = (id: string, count: number) => {
			const w = ds.weapons.getAny(id) ?? ds.wargear.get(id);
			return { ref: ref(id, w?.name ?? id), count };
		};
		const wargear = [...bu.loadout.entries()]
			.filter(([, count]) => count > 0)
			.map(([id, count]) => weaponRef(id, count));
		// Per-model-type breakdown for grouped export; absent when it can't decompose
		// exactly (the exporters then fall back to the aggregate `wargear`).
		const groups = loadoutGroups(bu, armyFaction);
		const loadout_groups = groups
			? groups.map((g) => ({
					model_name: g.model_name,
					count: g.count,
					wargear: g.weapons.map((w) => weaponRef(w.id, w.count)),
				}))
			: undefined;
		// A leader's attachment is emitted on its own row, pointing at the bodyguard.
		const bodyguard = bu.attachedToKey ? byKey.get(bu.attachedToKey) : undefined;
		const bodyguardRaw = bodyguard ? buRaw(bodyguard, armyFaction) : undefined;
		const leader_attachment = bodyguard
			? {
					bodyguard_ref: ref(bodyguard.datasheetId, bodyguardRaw?.name ?? bodyguard.datasheetId),
					role: "leader" as const,
					provisional: false,
				}
			: null;
		return {
			ref: ref(bu.datasheetId, name),
			model_count: bu.modelCount,
			points: unit ? baseUnitPoints(unit, bu.modelCount, ordinals.get(bu.key)) : null,
			is_warlord: bu.isWarlord,
			enhancement: enh ? ref(enh.id, enh.name) : null,
			enhancement_points: enh?.cost ?? null,
			wargear,
			...(loadout_groups ? { loadout_groups } : {}),
			leader_attachment,
		};
	});

	const total = totalPoints(state);
	return {
		name: state.name || 'Untitled',
		source: { format: 'roster-json', generated_by: 'Shadowboxing builder' },
		faction_id: factionName,
		detachments,
		battle_size: state.battleSize,
		// The picked (or detachment-forced) disposition — mandatory for a legal list.
		// The builder auto-locks it to the sole option when a detachment grants one,
		// so it is always set; carry it through to the roster/exports.
		force_disposition: state.disposition,
		points: {
			declared_limit: pointsLimit(state),
			detachment_cap: detachmentPointCap(state),
			total_reported: total,
			total_computed: total,
		},
		units,
		game_version: { edition: '11th', dataslate: 'pre-launch-provisional' },
		diagnostics: {
			resolved_units: units.length,
			unresolved_units: 0,
			resolved_weapons: 0,
			unresolved_weapons: 0,
			warnings: [],
		},
	};
}

/** The roster-json text the library import pipeline consumes. */
export function builderToRosterJson(state: BuilderState): string {
	return exportRoster(builderToRoster(state), 'roster-json');
}

// ── Seed from an existing list (Edit in Builder) ───────────────────────────────

let seedCounter = 0;

/**
 * Build a draft from list text (roster-json or any importable format) by
 * running it through `tryImportRoster`. `disposition` comes from the saved
 * config (lists don't encode it). Returns null when the text can't import.
 */
export function rosterTextToBuilderState(
	text: string,
	name: string,
	disposition: string | null,
	pointsLimitOverride: number | null = null,
): BuilderState | null {
	const result = tryImportRoster(text);
	if (!result.ok) return null;
	const roster = result.roster;

	const battleSizeFromRoster: BattleSize =
		roster.battle_size === 'incursion' ? 'incursion' : 'strike-force';

	const resolvable = roster.units.filter((ru) => ru.ref.id != null);
	const units: BuilderUnit[] = resolvable.map((ru) => {
		const loadout = new Map<string, number>();
		for (const w of ru.wargear) {
			if (w.ref.id) loadout.set(w.ref.id, w.count);
		}
		const datasheetId = ru.ref.id as string;
		return {
			key: `seed${seedCounter++}`,
			datasheetId,
			modelCount: ru.model_count,
			// Imports under-record always-on base weapons — repair against bounds.
			loadout: reconcileLoadout(datasheetId, ru.model_count, loadout, roster.faction_id ?? undefined),
			enhancementId: ru.enhancement?.id ?? null,
			isWarlord: ru.is_warlord,
		};
	});

	// Restore leader→bodyguard attachments. `leader_attachment` lives on the
	// leader's row and points at the bodyguard's datasheet; bind it to the first
	// matching draft row (rows share the leader's index with `resolvable`).
	resolvable.forEach((ru, i) => {
		const bodyguardId = ru.leader_attachment?.bodyguard_ref.id;
		if (!bodyguardId) return;
		const bodyguard = units.find((u) => u.datasheetId === bodyguardId);
		if (bodyguard) units[i].attachedToKey = bodyguard.key;
	});

	return {
		name,
		factionId: roster.faction_id,
		detachmentIds: roster.detachments.flatMap((d) => (d.ref.id ? [d.ref.id] : [])),
		battleSize: battleSizeFromRoster,
		...(pointsLimitOverride != null ? { pointsLimitOverride } : {}),
		disposition,
		units,
	};
}

// ── Compact share tokens (registry-indexed `share-v1`) ─────────────────────────

/**
 * Lower a draft to a {@link ShareList} — the lossless essential subset the
 * `share-v1` codec encodes. Unlike the roster-json round-trip, this preserves an
 * allied unit's source faction + rule, its `selectedGrants`, the draft
 * `disposition`, and the exact leader→bodyguard binding (as an ordinal into the
 * unit list, robust to repeated datasheets).
 */
export function builderStateToShareList(state: BuilderState): ShareList {
	const ordinalOf = new Map(state.units.map((u, i) => [u.key, i]));
	return {
		name: state.name,
		factionId: state.factionId,
		detachmentIds: state.detachmentIds,
		battleSize: state.battleSize,
		disposition: state.disposition,
		units: state.units.map((bu) => ({
			datasheetId: bu.datasheetId,
			modelCount: bu.modelCount,
			isWarlord: bu.isWarlord,
			enhancementId: bu.enhancementId,
			allyFactionId: bu.factionId ?? null,
			allyRuleId: bu.allyRuleId ?? null,
			attachedToOrdinal:
				bu.attachedToKey != null ? (ordinalOf.get(bu.attachedToKey) ?? null) : null,
			grants: bu.selectedGrants ?? [],
			loadout: [...bu.loadout.entries()].filter(([, count]) => count > 0),
		})),
	};
}

/**
 * Rebuild a draft from a decoded {@link ShareList}. The loadout is restored
 * verbatim (the share format is lossless, so — unlike an import — there are no
 * under-recorded base weapons to repair). Attachments are re-bound from their
 * stored ordinals after every row has a key.
 */
export function shareListToBuilderState(list: ShareList): BuilderState {
	const battleSize: BattleSize = list.battleSize === 'incursion' ? 'incursion' : 'strike-force';
	const units: BuilderUnit[] = list.units.map((su) => ({
		key: `seed${seedCounter++}`,
		datasheetId: su.datasheetId,
		factionId: su.allyFactionId ?? undefined,
		allyRuleId: su.allyRuleId ?? undefined,
		selectedGrants: su.grants.length > 0 ? [...su.grants] : undefined,
		modelCount: su.modelCount,
		loadout: new Map(su.loadout),
		enhancementId: su.enhancementId,
		isWarlord: su.isWarlord,
	}));

	list.units.forEach((su, i) => {
		if (su.attachedToOrdinal != null && units[su.attachedToOrdinal]) {
			units[i].attachedToKey = units[su.attachedToOrdinal].key;
		}
	});

	return {
		name: list.name,
		factionId: list.factionId,
		detachmentIds: [...list.detachmentIds],
		battleSize,
		disposition: list.disposition,
		units,
	};
}
