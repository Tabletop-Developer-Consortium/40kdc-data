/**
 * Unit tests for the native list-builder logic. Runs in node against the
 * embedded dataset twin (no browser). The Roster round-trip is also pinned
 * cross-impl in 40kdc-data's conformance suite; here we verify the builder's
 * own derivations and that what it emits re-imports unchanged.
 */
import { describe, it, expect } from 'vitest';
import { ds } from './dataset';
import {
	emptyBuilderState,
	baseUnitPoints,
	pointsTierMissing,
	unitsForFaction,
	detachmentsForFaction,
	eligibleEnhancements,
	defaultLoadout,
	builderUnitToDatacardData,
	wargearOptionsFor,
	loadoutViolations,
	totalPoints,
	pointsLimit,
	nextCopyCost,
	canAfford,
	builderViolations,
	detachmentTagConflicts,
	builderToRoster,
	builderToRosterJson,
	rosterTextToBuilderState,
	unitRaw,
	groupUnitsByRole,
	groupDraftByRole,
	roleOf,
	sectionOf,
	cloneBuilderUnit,
	loadoutSummary,
	reconcileLoadout,
	itemName,
	unitTypeKeywords,
	alliesForState,
	allyPointsLimit,
	unitMatchesQuery,
	groupAlliesByGod,
	canBeWarlord,
	isLeader,
	attachableBodyguards,
	effectiveKeywords,
	selectableGrantsFor,
	type BuilderState,
	type BuilderUnit,
} from './builder';
import { tryImportRoster } from '@alpaca-software/40kdc-data';

/** First Space Marines unit with a points table and a model-count range. */
function sampleUnit() {
	const u = unitsForFaction('adeptus-astartes').find(
		(x) => (x.points?.length ?? 0) > 0 && x.model_count != null,
	);
	if (!u) throw new Error('no sample SM unit with points + model_count');
	return u;
}

function makeUnit(datasheetId: string, modelCount: number): BuilderUnit {
	const raw = unitRaw(datasheetId)!;
	return {
		key: 'k0',
		datasheetId,
		modelCount,
		loadout: defaultLoadout(raw, modelCount),
		enhancementId: null,
		isWarlord: false,
	};
}

describe('builder points', () => {
	it('picks the highest tier whose threshold the model count reaches', () => {
		const u = sampleUnit();
		const tiers = (u.points ?? []).slice().sort((a, b) => a.models - b.models);
		expect(tiers.length).toBeGreaterThan(0);
		// At each tier's model count, cost equals that tier's cost.
		for (const t of tiers) {
			expect(baseUnitPoints(u, t.models)).toBe(t.cost);
		}
		// Below the smallest tier, falls back to the smallest tier's cost.
		expect(baseUnitPoints(u, tiers[0].models - 1)).toBe(tiers[0].cost);
	});

	it('flags a model count below the smallest points tier', () => {
		const u = sampleUnit();
		const minModels = Math.min(...(u.points ?? []).map((t) => t.models));
		expect(pointsTierMissing(u, minModels - 1)).toBe(true);
		expect(pointsTierMissing(u, minModels)).toBe(false);
	});

	it('sums unit points across the draft', () => {
		const u = sampleUnit();
		const minModels = u.model_count?.min ?? 1;
		const state: BuilderState = {
			...emptyBuilderState(),
			factionId: 'adeptus-astartes',
			units: [makeUnit(u.id, minModels), makeUnit(u.id, minModels)],
		};
		expect(totalPoints(state)).toBe(2 * baseUnitPoints(u, minModels));
	});

	it('prices repeated ordinal-banded units by army copy', () => {
		// World Eaters Chaos Terminators: 175 for your 1st–2nd copy, 185 for the 3rd+.
		const we = 'world-eaters';
		const raw = unitRaw('chaos-terminators', undefined, we)!;
		const mk = (key: string): BuilderUnit => ({
			key,
			datasheetId: 'chaos-terminators',
			modelCount: 5,
			loadout: defaultLoadout(raw, 5),
			enhancementId: null,
			isWarlord: false,
		});
		const state: BuilderState = {
			...emptyBuilderState(),
			factionId: we,
			units: [mk('a'), mk('b'), mk('c')],
		};
		expect(baseUnitPoints(raw, 5, 1)).toBe(175);
		expect(baseUnitPoints(raw, 5, 3)).toBe(185);
		expect(totalPoints(state)).toBe(175 + 175 + 185);
	});

	// Regression guard (the original World Eaters export bug): the *exported*
	// roster — not just the in-memory total — must carry ordinal-aware per-unit
	// points. A single Chaos Terminators unit exports at 175 (band #1–2), never
	// 185 (band #3+), and the 3rd identical copy steps up to 185.
	it('threads ordinal pricing all the way through builderToRoster', () => {
		const we = 'world-eaters';
		const raw = unitRaw('chaos-terminators', undefined, we)!;
		const mk = (key: string): BuilderUnit => ({
			key,
			datasheetId: 'chaos-terminators',
			modelCount: 5,
			loadout: defaultLoadout(raw, 5),
			enhancementId: null,
			isWarlord: false,
		});

		// A lone unit: 175, not 185.
		const solo = builderToRoster({ ...emptyBuilderState(), factionId: we, units: [mk('a')] });
		expect(solo.units[0].points).toBe(175);
		expect(solo.points.total_computed).toBe(175);

		// Three copies: the 3rd crosses into the higher band.
		const three = builderToRoster({
			...emptyBuilderState(),
			factionId: we,
			units: [mk('a'), mk('b'), mk('c')],
		});
		expect(three.units.map((u) => u.points)).toEqual([175, 175, 185]);
		expect(three.points.total_computed).toBe(535);
	});

	it('carries the selected/forced disposition onto the roster (force_disposition)', () => {
		// The builder auto-locks a detachment's sole disposition into state.disposition;
		// builderToRoster must thread it onto the roster so exports (e.g. ATC) print it
		// instead of an em dash. Regression for the live list-builder ATC export.
		const we = 'world-eaters';
		const withDisp = builderToRoster({ ...emptyBuilderState(), factionId: we, disposition: 'take-and-hold' });
		expect(withDisp.force_disposition).toBe('take-and-hold');
		expect(builderToRoster({ ...emptyBuilderState(), factionId: we }).force_disposition).toBeNull();
	});
});

describe('builder default loadout', () => {
	// Regression guard (the other half of the World Eaters export bug): a
	// freshly-added unit must default to the legal base (no-swap) loadout, NOT the
	// take-every-swap maximal set, which stacked 11×combi / 7×chainfist on 5
	// models. validateLoadout does NOT catch that (messy multi-choice options
	// back off the swap-conflict check), so we assert the defining symptom
	// directly: no weapon is carried by more models than the unit has.
	it('defaults a freshly-added unit to the legal base loadout', () => {
		const we = 'world-eaters';
		const raw = unitRaw('chaos-terminators', undefined, we)!;
		const loadout = defaultLoadout(raw, 5);

		for (const [id, count] of loadout) {
			expect(count, `${id} exceeds the 5-model count`).toBeLessThanOrEqual(5);
		}
		// The legal default is each model's recorded datasheet loadout: combi-bolter
		// + accursed weapon, no swaps — NOT the orphan heavy weapons (heavy-flamer /
		// reaper-autocannon) the old weapon_ids inference wrongly promoted to base.
		expect(Object.fromEntries(loadout)).toEqual({
			'combi-bolter': 5,
			'accursed-weapon': 5,
		});
		// Total ≈ modelCount × weapons-per-model (2): no model over- or under-equipped.
		const total = [...loadout.values()].reduce((a, b) => a + b, 0);
		expect(total).toBe(5 * 2);
	});
});

describe('builder enhancements', () => {
	it('only offers enhancements scoped to the detachment, and only for characters', () => {
		const dets = detachmentsForFaction('adeptus-astartes');
		const det = dets.find((d) => (d.enhancement_ids?.length ?? 0) > 0);
		if (!det) return; // dataset may not carry enhancements yet
		// A non-character unit gets none.
		const squad = unitsForFaction('adeptus-astartes').find(
			(u) => !(u.keywords ?? []).some((k) => k.toLowerCase() === 'character'),
		);
		if (squad) {
			expect(eligibleEnhancements([det.id], squad)).toHaveLength(0);
		}
	});
});

describe('builder export round-trips', () => {
	it('emits roster-json that re-imports with the same units and ids', () => {
		const u = sampleUnit();
		const minModels = u.model_count?.min ?? 1;
		const state: BuilderState = {
			...emptyBuilderState(),
			name: 'Round Trip',
			factionId: 'adeptus-astartes',
			units: [makeUnit(u.id, minModels)],
		};

		const json = builderToRosterJson(state);
		const result = tryImportRoster(json);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.format).toBe('roster-json');
		expect(result.roster.units).toHaveLength(1);
		expect(result.roster.units[0].ref.id).toBe(u.id);
		expect(result.roster.units[0].model_count).toBe(minModels);
	});

	it('seeds a builder state back from its own export', () => {
		const u = sampleUnit();
		const minModels = u.model_count?.min ?? 1;
		const state: BuilderState = {
			...emptyBuilderState(),
			name: 'Seed Me',
			factionId: 'adeptus-astartes',
			disposition: 'take-and-hold',
			units: [makeUnit(u.id, minModels)],
		};

		const json = builderToRosterJson(state);
		const seeded = rosterTextToBuilderState(json, 'Seed Me', 'take-and-hold');
		expect(seeded).not.toBeNull();
		expect(seeded!.units).toHaveLength(1);
		expect(seeded!.units[0].datasheetId).toBe(u.id);
		expect(seeded!.units[0].modelCount).toBe(minModels);
		// Disposition isn't list-encoded; it's carried through the arg.
		expect(seeded!.disposition).toBe('take-and-hold');
	});

	it('returns null when the text is not importable', () => {
		expect(rosterTextToBuilderState('not a list', 'x', null)).toBeNull();
	});
});

describe('builder violations are advisory', () => {
	it('reports a points overrun without throwing', () => {
		const u = sampleUnit();
		const state: BuilderState = {
			...emptyBuilderState(),
			battleSize: 'incursion',
			factionId: 'adeptus-astartes',
			// Enough copies to blow the 1000pt incursion ceiling.
			units: Array.from({ length: 40 }, (_, i) => ({
				...makeUnit(u.id, u.model_count?.min ?? 1),
				key: `k${i}`,
			})),
		};
		const issues = builderViolations(state);
		expect(issues.some((v) => v.unitKey === null && /over the/.test(v.message))).toBe(true);
	});

	it('flags more than one warlord', () => {
		const u = sampleUnit();
		const mc = u.model_count?.min ?? 1;
		const state: BuilderState = {
			...emptyBuilderState(),
			factionId: 'adeptus-astartes',
			units: [
				{ ...makeUnit(u.id, mc), key: 'a', isWarlord: true },
				{ ...makeUnit(u.id, mc), key: 'b', isWarlord: true },
			],
		};
		expect(builderViolations(state).some((v) => /warlord/.test(v.message))).toBe(true);
	});
});

describe('detachment tag conflicts', () => {
	it('flags two detachments that share a tag (only one of that type)', () => {
		// Necrons Awakened Dynasty + Hand of the Dynasty both carry the `dynasty` tag.
		const a = ds.detachments.get('awakened-dynasty');
		const b = ds.detachments.get('hand-of-the-dynasty');
		expect((a?.tags ?? []).includes('dynasty')).toBe(true);
		expect((b?.tags ?? []).includes('dynasty')).toBe(true);
		const state: BuilderState = {
			...emptyBuilderState(),
			factionId: 'necrons',
			detachmentIds: ['awakened-dynasty', 'hand-of-the-dynasty'],
		};
		const conflicts = detachmentTagConflicts(state);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].tag).toBe('dynasty');
		// Named in selection order.
		expect(conflicts[0].detachmentNames).toEqual([a!.name, b!.name]);
		// Surfaces as an army-level advisory chip (never blocks save).
		expect(
			builderViolations(state).some((v) => v.unitKey === null && /dynasty/.test(v.message)),
		).toBe(true);
	});

	it('does not flag a single detachment, or two with no shared tag', () => {
		const single: BuilderState = {
			...emptyBuilderState(),
			factionId: 'necrons',
			detachmentIds: ['awakened-dynasty'],
		};
		expect(detachmentTagConflicts(single)).toHaveLength(0);
		// awakened-dynasty (dynasty) + cryptek-conclave (no tag) → no shared tag.
		const mixed: BuilderState = {
			...emptyBuilderState(),
			factionId: 'necrons',
			detachmentIds: ['awakened-dynasty', 'cryptek-conclave'],
		};
		expect(detachmentTagConflicts(mixed)).toHaveLength(0);
	});

	it('names every detachment carrying a conflicting tag in one entry', () => {
		// Synthetic 3-way share isn't in the dataset; verify the grouping collapses
		// repeated ids of a tagged detachment into a single entry naming each pick.
		const state: BuilderState = {
			...emptyBuilderState(),
			factionId: 'necrons',
			detachmentIds: ['awakened-dynasty', 'hand-of-the-dynasty', 'the-phaerons-armoury'],
		};
		// dynasty: awakened-dynasty + hand-of-the-dynasty; hypercrypt: only phaeron → not a conflict.
		const conflicts = detachmentTagConflicts(state);
		expect(conflicts.map((c) => c.tag)).toEqual(['dynasty']);
		expect(conflicts[0].detachmentNames).toHaveLength(2);
	});
});

describe('builder role grouping', () => {
	it('buckets every picker unit into exactly one section, names sorted', () => {
		const units = unitsForFaction('adeptus-astartes');
		const groups = groupUnitsByRole(units);
		// Partition: total covered == total input, no dupes.
		const covered = groups.reduce((n, g) => n + g.units.length, 0);
		expect(covered).toBe(units.length);
		// Each group's section matches every unit in it, and names are sorted.
		for (const g of groups) {
			for (const u of g.units) expect(sectionOf(u).key).toBe(g.key);
			const names = g.units.map((u) => u.name);
			expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		}
		// Sections are emitted in ascending display order.
		const orders = groups.map((g) => g.order);
		expect(orders).toEqual([...orders].sort((a, b) => a - b));
	});

	it('splits the un-roled bucket by unit type (Infantry/Beast/Vehicle/…)', () => {
		// A faction with non-battlefield-role units exercises the type split.
		const units = unitsForFaction('tau-empire');
		const groups = groupUnitsByRole(units);
		const otherKeys = groups.map((g) => g.key).filter((k) => k.startsWith('other'));
		// Any un-roled units should land in type-suffixed sections, not one lump.
		for (const g of groups) {
			if (!g.key.startsWith('other:')) continue;
			const type = g.label; // e.g. "Vehicle"
			for (const u of g.units) {
				expect(unitTypeKeywords(u)[0]).toBe(type);
			}
		}
		// If there are un-roled units at all, at least one typed section exists.
		const hasUnroled = units.some((u) => roleOf(u) === 'other' && unitTypeKeywords(u).length > 0);
		if (hasUnroled) {
			expect(otherKeys.some((k) => k.includes(':'))).toBe(true);
		}
	});

	it('roster subtotals sum to the grand total and preserve insertion order', () => {
		const u = sampleUnit();
		const mc = u.model_count?.min ?? 1;
		const state: BuilderState = {
			...emptyBuilderState(),
			factionId: 'adeptus-astartes',
			units: [
				{ ...makeUnit(u.id, mc), key: 'a' },
				{ ...makeUnit(u.id, mc), key: 'b' },
			],
		};
		const groups = groupDraftByRole(state);
		const subtotal = groups.reduce((n, g) => n + g.points, 0);
		expect(subtotal).toBe(totalPoints(state));
		// Same datasheet ⇒ one section, insertion order intact.
		const section = groups.find((g) => g.units.length === 2);
		expect(section).toBeDefined();
		expect(section!.units.map((x) => x.key)).toEqual(['a', 'b']);
	});
});

describe('builder unit clone + display', () => {
	it('clones a configured unit with a fresh key and an independent loadout', () => {
		const u = sampleUnit();
		const original = makeUnit(u.id, u.model_count?.min ?? 1);
		original.isWarlord = true;
		const clone = cloneBuilderUnit(original, 'k1');
		expect(clone.key).toBe('k1');
		expect(clone.isWarlord).toBe(false); // exactly one warlord
		// Mutating the clone's loadout must not touch the original's Map.
		const firstId = [...original.loadout.keys()][0];
		if (firstId) {
			clone.loadout.set(firstId, (original.loadout.get(firstId) ?? 0) + 5);
			expect(clone.loadout.get(firstId)).not.toBe(original.loadout.get(firstId));
		}
	});

	it('summarises the equipped weapons (count> 0) and never throws', () => {
		const units = unitsForFaction('adeptus-astartes');
		for (const u of units.slice(0, 25)) {
			const bu = makeUnit(u.id, u.model_count?.min ?? 1);
			const summary = loadoutSummary(bu);
			expect(typeof summary).toBe('string');
			// Every equipped item's display name appears in the summary.
			for (const [id, count] of bu.loadout) {
				if (count > 0) expect(summary).toContain(itemName(id));
			}
			// Type keywords are a subset of the recognised family.
			expect(unitTypeKeywords(u).length).toBeLessThanOrEqual(10);
		}
	});
});

describe('builder loadout reconciliation', () => {
	it('forces a fixed base weapon to its required count (under-recorded base weapon)', () => {
		const u = unitRaw('kroot-carnivores');
		if (!u) return; // dataset may not carry T'au
		const mc = u.model_count?.min ?? 10;
		// The recorded default loadout is kroot-rifle + close combat weapon on every
		// model. The close combat weapon is a *fixed* base weapon — in the default
		// loadout and swapped by no option (the kroot-rifle, by contrast, is
		// swappable for a tanglebomb launcher / carbine). Simulate an import that
		// under-records that always-on weapon.
		const seeded = new Map<string, number>([['close-combat-weapon', 3]]);
		const fixed = reconcileLoadout('kroot-carnivores', mc, seeded);
		// A fixed base weapon → must be forced back to the model count, no violation.
		expect(fixed.get('close-combat-weapon')).toBe(mc);
		const bu: BuilderUnit = {
			key: 'k',
			datasheetId: 'kroot-carnivores',
			modelCount: mc,
			loadout: fixed,
			enhancementId: null,
			isWarlord: false,
		};
		const issues = builderViolations({
			...emptyBuilderState(),
			factionId: 'tau-empire',
			units: [bu],
		}).filter((v) => v.unitKey === 'k' && /close-combat-weapon/.test(v.message));
		expect(issues).toHaveLength(0);
	});
});

describe('valid allies (soup)', () => {
	it('alliesForState offers Daemonic Pact for Chaos Knights with a non-empty pool', () => {
		const groups = alliesForState({ ...emptyBuilderState(), factionId: 'chaos-knights' });
		const pact = groups.find((g) => g.rule.id === 'daemonic-pact');
		expect(pact).toBeDefined();
		expect(pact!.label).toBe('Daemons');
		expect(pact!.units.length).toBeGreaterThan(0);
	});

	it('alliesForState gates detachment-scoped rules on the selected detachment', () => {
		const base = { ...emptyBuilderState(), factionId: 'chaos-knights' };
		const without = alliesForState(base).map((g) => g.rule.id);
		expect(without).not.toContain('iconoclast-fiefdom-damned');
		const withDet = alliesForState({ ...base, detachmentIds: ['iconoclast-fiefdom'] }).map(
			(g) => g.rule.id,
		);
		expect(withDet).toContain('iconoclast-fiefdom-damned');
	});

	it('allyPointsLimit reads the per-battle-size cap', () => {
		const pact = ds.alliedRules.get('daemonic-pact')!;
		expect(allyPointsLimit(pact, 'incursion')).toBe(250);
		expect(allyPointsLimit(pact, 'strike-force')).toBe(500);
	});

	it('unitMatchesQuery matches on name substring and exact keyword', () => {
		const bloodletters = unitRaw('bloodletters', 'chaos-daemons')!;
		expect(unitMatchesQuery(bloodletters, 'blood')).toBe(true); // name
		expect(unitMatchesQuery(bloodletters, 'Khorne')).toBe(true); // keyword
		expect(unitMatchesQuery(bloodletters, 'tyranids')).toBe(false);
		expect(unitMatchesQuery(bloodletters, '')).toBe(true);
	});

	it('flags an allied unit marked Warlord or given an Enhancement', () => {
		const ally: BuilderUnit = {
			key: 'a',
			datasheetId: 'bloodletters',
			factionId: 'chaos-daemons',
			allyRuleId: 'daemonic-pact',
			modelCount: 10,
			loadout: new Map(),
			enhancementId: null,
			isWarlord: true,
		};
		const issues = builderViolations({
			...emptyBuilderState(),
			factionId: 'chaos-knights',
			units: [ally],
		});
		expect(issues.some((v) => /cannot be Warlord/.test(v.message))).toBe(true);
	});

	it('flags more than three of a non-Battleline datasheet', () => {
		const wl = unitsForFaction('adeptus-astartes').find(
			(u) =>
				(u.points?.length ?? 0) > 0 &&
				!(u.keywords ?? []).map((k) => k.toLowerCase()).includes('battleline') &&
				u.role !== 'dedicated-transport' &&
				u.role !== 'epic-hero',
		)!;
		const mk = (i: number): BuilderUnit => ({
			key: `c${i}`,
			datasheetId: wl.id,
			modelCount: wl.model_count?.min ?? 1,
			loadout: new Map(),
			enhancementId: null,
			isWarlord: false,
		});
		const issues = builderViolations({
			...emptyBuilderState(),
			factionId: 'adeptus-astartes',
			units: [mk(0), mk(1), mk(2), mk(3)],
		});
		expect(issues.some((v) => /max \d+ of a datasheet/.test(v.message))).toBe(true);
	});
});

describe('shared Chaos datasheets resolve to the army faction', () => {
	// Chaos Spawn / Master of Executions / Rhino share one datasheet id across
	// several Chaos faction files with different faction_keywords. Own-army units
	// carry no factionId (kept out of the share encoding), so resolution must fall
	// back to the army faction or they pick the first-registered copy (Heretic
	// Astartes) and trip keyword checks that expect the army's own keyword.
	it('picks the army-faction copy for a shared own-army datasheet id', () => {
		const we = unitRaw('chaos-spawn', undefined, 'world-eaters');
		expect(we?.faction_keywords).toContain('World Eaters');
		const moe = unitRaw('master-of-executions', undefined, 'world-eaters');
		expect(moe?.faction_keywords).toContain('World Eaters');
		// An ally's explicit faction still wins over the army fallback.
		const csm = unitRaw('chaos-spawn', 'chaos-space-marines', 'world-eaters');
		expect(csm?.faction_keywords).toContain('Heretic Astartes');
	});

	it('resolves the World Eaters Chaos Terminators, not the Emperor’s Children copy', () => {
		// Regression for the reported bug: chaos-terminators exists only under
		// world-eaters + emperors-children; emperors-children sorts first, so a
		// faction-blind lookup returned the wrong (Slaanesh, 5-model) datasheet.
		const we = unitRaw('chaos-terminators', undefined, 'world-eaters');
		expect(we?.faction_id).toBe('world-eaters');
		expect(we?.profiles[0]?.name).toBe('World Eaters Terminator');
		expect(we?.keywords).toContain('Khorne');
		expect(we?.keywords).not.toContain('Slaanesh');
		// Data regression: WE fields 5–10 models (its points table has a 10-model
		// tier); the view-split had swapped the cap with the EC copy.
		expect(we?.model_count).toEqual({ min: 5, max: 10 });
		const ec = unitRaw('chaos-terminators', undefined, 'emperors-children');
		expect(ec?.keywords).toContain('Slaanesh');
		expect(ec?.model_count).toEqual({ min: 5, max: 5 });
	});

	it('resolves a shared vehicle chassis to the army faction’s keywords only', () => {
		// The generic chaos-space-marines Land Raider legitimately carries all
		// four god marks; a WE list must see the Khorne-only WE copy, not that one.
		const lr = unitRaw('chaos-land-raider', undefined, 'world-eaters');
		expect(lr?.faction_id).toBe('world-eaters');
		expect(lr?.keywords).toContain('Khorne');
		for (const god of ['Slaanesh', 'Nurgle', 'Tzeentch']) {
			expect(lr?.keywords).not.toContain(god);
		}
		// "Frame" is a model-build tag the dataset omits everywhere; it had leaked
		// onto the WE vehicle copies only.
		expect(lr?.keywords).not.toContain('Frame');
	});

	it('stamps faction onto the datacard and scopes wargear for a shared chassis', () => {
		const bu: BuilderUnit = {
			key: 't',
			datasheetId: 'chaos-terminators',
			modelCount: 5,
			loadout: new Map(),
			enhancementId: null,
			isWarlord: false,
		};
		// builderUnitToDatacardData resolves via the army faction and records it,
		// so the (id-only) Datacard re-resolves the right copy instead of first-wins.
		expect(builderUnitToDatacardData(bu, 'world-eaters').faction_id).toBe('world-eaters');
		// Faction-scoped wargear/loadout lookups resolve (and never trip the
		// units guard) for a shared id.
		expect(wargearOptionsFor('chaos-terminators', undefined, 'world-eaters')).toBeDefined();
		expect(loadoutViolations(bu, 'world-eaters')).toEqual([]);
	});

	it('does not flag own World Eaters units when a Chaos Knights ally is present', () => {
		const ckRule = alliesForState({ ...emptyBuilderState(), factionId: 'world-eaters' }).find(
			(g) => g.rule.id === 'world-eaters-chaos-knights',
		);
		expect(ckRule).toBeDefined();
		expect(ckRule!.units.length).toBeGreaterThan(0);

		const own = (id: string, key: string): BuilderUnit => ({
			key,
			datasheetId: id,
			modelCount: unitRaw(id, undefined, 'world-eaters')?.model_count?.min ?? 1,
			loadout: new Map(),
			enhancementId: null,
			isWarlord: false,
		});
		const ally: BuilderUnit = {
			key: 'ck',
			datasheetId: ckRule!.units[0].id,
			factionId: 'chaos-knights',
			allyRuleId: 'world-eaters-chaos-knights',
			modelCount: 1,
			loadout: new Map(),
			enhancementId: null,
			isWarlord: false,
		};
		const issues = builderViolations({
			...emptyBuilderState(),
			factionId: 'world-eaters',
			units: [own('chaos-spawn', 's'), own('master-of-executions', 'm'), ally],
		});
		expect(issues.some((v) => /every army model must have/.test(v.message))).toBe(false);
	});
});

describe('daemon allies grouped by Chaos god', () => {
	it("splits Daemonic Pact's pool into the four gods plus Undivided, losing no units", () => {
		const pact = alliesForState({ ...emptyBuilderState(), factionId: 'chaos-knights' }).find(
			(g) => g.rule.id === 'daemonic-pact',
		)!;
		const buckets = groupAlliesByGod(pact.units);
		const gods = buckets.map((b) => b.god);
		expect(gods).toEqual(['Khorne', 'Tzeentch', 'Nurgle', 'Slaanesh', 'Undivided']);
		for (const b of buckets) expect(b.units.length).toBeGreaterThan(0);
		// Grouping is a pure partition — every unit lands in exactly one bucket.
		const total = buckets.reduce((n, b) => n + b.units.length, 0);
		expect(total).toBe(pact.units.length);
	});

	it('returns a single null bucket for a pool with no god dimension', () => {
		const damned = alliesForState({
			...emptyBuilderState(),
			factionId: 'chaos-knights',
			detachmentIds: ['iconoclast-fiefdom'],
		}).find((g) => g.rule.id === 'iconoclast-fiefdom-damned')!;
		const buckets = groupAlliesByGod(damned.units);
		expect(buckets).toHaveLength(1);
		expect(buckets[0].god).toBeNull();
		expect(buckets[0].units.length).toBe(damned.units.length);
	});
});

describe('leader attachment (11e)', () => {
	// Pick any Space Marine leader with at least one eligible bodyguard.
	function leaderAndBodyguard() {
		const leader = ds.units
			.byFaction('adeptus-astartes')
			.find((u) => ds.bodyguardsAttachableFrom(u.id).length > 0);
		if (!leader) throw new Error('no SM leader with a bodyguard in the dataset');
		const bodyguardId = ds.bodyguardsAttachableFrom(leader.id)[0].id;
		return { leaderId: leader.id, bodyguardId };
	}

	it('offers eligible bodyguards and emits + round-trips the attachment', () => {
		const { leaderId, bodyguardId } = leaderAndBodyguard();
		expect(isLeader(ds.units.get(leaderId)!.raw)).toBe(true);

		const lead: BuilderUnit = { ...makeUnit(leaderId, 1), key: 'L' };
		const body: BuilderUnit = { ...makeUnit(bodyguardId, ds.units.get(bodyguardId)!.raw.model_count?.min ?? 1), key: 'B' };
		const state: BuilderState = { ...emptyBuilderState(), factionId: 'adeptus-astartes', units: [lead, body] };

		// The bodyguard is offered to the leader.
		expect(attachableBodyguards(state, lead).map((u) => u.key)).toContain('B');

		// Attach, export — leader_attachment lands on the leader's row.
		lead.attachedToKey = 'B';
		const roster = builderToRosterJson(state);
		const result = tryImportRoster(roster);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const leaderRow = result.roster.units.find((u) => u.ref.id === leaderId);
		expect(leaderRow?.leader_attachment?.bodyguard_ref.id).toBe(bodyguardId);

		// Re-seed a draft from the export — attachment is restored onto the leader.
		const seeded = rosterTextToBuilderState(roster, 'x', null)!;
		const seededLeader = seeded.units.find((u) => u.datasheetId === leaderId)!;
		const seededBody = seeded.units.find((u) => u.datasheetId === bodyguardId)!;
		expect(seededLeader.attachedToKey).toBe(seededBody.key);
	});
});

describe('warlord eligibility', () => {
	it('is false for an ally unit barred by its rule, and for non-characters', () => {
		// A Daemon CHARACTER included via Daemonic Pact (cannot_be_warlord) is barred.
		const daemon: BuilderUnit = {
			key: 'd',
			datasheetId: 'bloodmaster',
			factionId: 'chaos-daemons',
			allyRuleId: 'daemonic-pact',
			modelCount: 1,
			loadout: new Map(),
			enhancementId: null,
			isWarlord: false,
		};
		expect(canBeWarlord(daemon)).toBe(false);
		// The same datasheet as a native daemon (no ally rule) is a character → eligible.
		expect(canBeWarlord({ ...daemon, factionId: 'chaos-daemons', allyRuleId: undefined })).toBe(true);
		// A non-character (War Dog) is never eligible.
		expect(canBeWarlord(makeUnit('war-dog-karnivore', 1))).toBe(false);
	});
});

describe('detachment-granted Battleline + reconcile-on-add', () => {
	it('grants Battleline to War Dogs under Houndpack Lance, raising the datasheet cap to 6', () => {
		const wd = unitRaw('war-dog-karnivore')!;
		expect(effectiveKeywords(wd, []).has('battleline')).toBe(false);
		expect(effectiveKeywords(wd, ['houndpack-lance']).has('battleline')).toBe(true);

		const mk = (i: number): BuilderUnit => ({ ...makeUnit('war-dog-karnivore', 1), key: `k${i}` });
		const five = [mk(0), mk(1), mk(2), mk(3), mk(4)];
		// Without Houndpack: cap 3 → flagged.
		expect(
			builderViolations({ ...emptyBuilderState(), factionId: 'chaos-knights', units: five }).some((v) =>
				/max 3 of a datasheet/.test(v.message),
			),
		).toBe(true);
		// With Houndpack: Battleline → cap 6 → no datasheet-cap violation.
		expect(
			builderViolations({
				...emptyBuilderState(),
				factionId: 'chaos-knights',
				detachmentIds: ['houndpack-lance'],
				units: five,
			}).some((v) => /max \d+ of a datasheet/.test(v.message)),
		).toBe(false);
	});

	it('reconcile-on-add yields no phantom "below min" loadout violation for Cultist Mob', () => {
		const raw = unitRaw('cultist-mob', 'chaos-space-marines')!;
		const mc = raw.model_count?.min ?? 10;
		const bu: BuilderUnit = {
			key: 'c',
			datasheetId: 'cultist-mob',
			factionId: 'chaos-space-marines',
			modelCount: mc,
			loadout: reconcileLoadout('cultist-mob', mc, defaultLoadout(raw, mc), 'chaos-space-marines'),
			enhancementId: null,
			isWarlord: false,
		};
		const issues = builderViolations({ ...emptyBuilderState(), factionId: 'chaos-knights', units: [bu] });
		expect(issues.some((v) => v.unitKey === 'c' && /below min/.test(v.message))).toBe(false);
	});
});

describe('Houndpack Lance: select War Dogs as CHARACTER', () => {
	const houndpack = ['houndpack-lance'];
	const warDog = (key: string, selected?: string[]): BuilderUnit => ({
		...makeUnit('war-dog-karnivore', 1),
		key,
		...(selected ? { selectedGrants: selected } : {}),
	});

	it('offers the CHARACTER grant to War Dogs under Houndpack, capped at 3', () => {
		const grants = selectableGrantsFor(unitRaw('war-dog-karnivore')!, houndpack);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ keyword: 'Character', maxSelected: 3 });
		// No such grant without the detachment.
		expect(selectableGrantsFor(unitRaw('war-dog-karnivore')!, [])).toHaveLength(0);
	});

	it('grants CHARACTER only to selected units, enabling Warlord', () => {
		const wd = unitRaw('war-dog-karnivore')!;
		// Blanket Battleline always; CHARACTER only when selected.
		expect(effectiveKeywords(wd, houndpack).has('battleline')).toBe(true);
		expect(effectiveKeywords(wd, houndpack).has('character')).toBe(false);
		expect(effectiveKeywords(wd, houndpack, ['Character']).has('character')).toBe(true);

		expect(canBeWarlord(warDog('a'), houndpack)).toBe(false);
		expect(canBeWarlord(warDog('a', ['Character']), houndpack)).toBe(true);
	});

	it('flags selecting more than three CHARACTER War Dogs', () => {
		const four = ['a', 'b', 'c', 'd'].map((k) => warDog(k, ['Character']));
		const issues = builderViolations({
			...emptyBuilderState(),
			factionId: 'chaos-knights',
			detachmentIds: houndpack,
			units: four,
		});
		expect(issues.some((v) => /Character selected \(max 3\)/.test(v.message))).toBe(true);
		// Three is fine.
		const three = ['a', 'b', 'c'].map((k) => warDog(k, ['Character']));
		expect(
			builderViolations({
				...emptyBuilderState(),
				factionId: 'chaos-knights',
				detachmentIds: houndpack,
				units: three,
			}).some((v) => /Character selected/.test(v.message)),
		).toBe(false);
	});
});

describe('Houndpack Lance: minimum War Dog units', () => {
	const houndpack = ['houndpack-lance'];
	const warDog = (key: string): BuilderUnit => ({ ...makeUnit('war-dog-karnivore', 1), key });

	it('flags fewer than three War Dogs, and clears at three', () => {
		const two = builderViolations({
			...emptyBuilderState(),
			factionId: 'chaos-knights',
			detachmentIds: houndpack,
			units: [warDog('a'), warDog('b')],
		});
		expect(two.some((v) => /requires 3\+ War Dog units/.test(v.message))).toBe(true);

		const three = builderViolations({
			...emptyBuilderState(),
			factionId: 'chaos-knights',
			detachmentIds: houndpack,
			units: [warDog('a'), warDog('b'), warDog('c')],
		});
		expect(three.some((v) => /requires .* War Dog units/.test(v.message))).toBe(false);
	});
});

describe('affordability (nextCopyCost / canAfford)', () => {
	const we = 'world-eaters';
	// Resolve the World Eaters copy explicitly — chaos-terminators is a shared
	// chassis, so a faction-less lookup is ambiguous.
	const raw = unitRaw('chaos-terminators', undefined, we)!;
	const mk = (key: string): BuilderUnit => ({
		key,
		datasheetId: 'chaos-terminators',
		modelCount: 5,
		loadout: defaultLoadout(raw, 5),
		enhancementId: null,
		isWarlord: false,
	});

	it('prices the next copy ordinal-aware (Chaos Terminators 175 → 185 on the 3rd)', () => {
		const empty: BuilderState = { ...emptyBuilderState(), factionId: we };
		expect(nextCopyCost(empty, raw)).toBe(175);

		const twoTaken: BuilderState = { ...emptyBuilderState(), factionId: we, units: [mk('a'), mk('b')] };
		expect(nextCopyCost(twoTaken, raw)).toBe(185);
	});

	it('canAfford flips false once the running total leaves no room', () => {
		// Override the limit to just above one 5-man squad (175): a second copy
		// (another 175) won't fit.
		const tight: BuilderState = {
			...emptyBuilderState(),
			factionId: we,
			pointsLimitOverride: 200,
			units: [mk('a')],
		};
		expect(totalPoints(tight)).toBe(175);
		expect(pointsLimit(tight)).toBe(200);
		expect(canAfford(tight, raw)).toBe(false);

		const roomy: BuilderState = { ...emptyBuilderState(), factionId: we, pointsLimitOverride: 400 };
		expect(canAfford(roomy, raw)).toBe(true);
	});
});
