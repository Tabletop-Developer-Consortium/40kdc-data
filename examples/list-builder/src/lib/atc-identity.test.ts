import { describe, it, expect } from 'vitest';
import { exportRoster, type ExportFormat, type Roster } from '@alpaca-software/40kdc-data';
import { applyAtcIdentity, isAtcFormat } from './atc-identity';

// A minimal real roster so we substitute against the package's actual ATC header
// (pins the line-label coupling — a package rename would break these tests, not
// silently no-op).
const roster: Roster = {
	name: 'T',
	source: { format: 'roster-json', generated_by: 'test' },
	faction_id: 'World Eaters',
	detachments: [],
	battle_size: 'strike-force',
	points: { declared_limit: 2000, detachment_cap: 3, total_reported: 0, total_computed: 0 },
	units: [],
	game_version: { edition: '11th', dataslate: 'launch' },
	diagnostics: { resolved_units: 0, unresolved_units: 0, resolved_weapons: 0, unresolved_weapons: 0, warnings: [] },
} as unknown as Roster;

const id = { playerName: 'Ada Lovelace', teamName: 'The Engines' };

describe('isAtcFormat', () => {
	it('matches only the ATC formats', () => {
		expect(isAtcFormat('atc-2026-compact')).toBe(true);
		expect(isAtcFormat('atc-2026-full')).toBe(true);
		expect(isAtcFormat('newrecruit-wtc-compact')).toBe(false);
		expect(isAtcFormat('roster-json')).toBe(false);
	});
});

describe('applyAtcIdentity', () => {
	for (const fmt of ['atc-2026-compact', 'atc-2026-full'] as const) {
		it(`substitutes player and team into the ${fmt} header`, () => {
			const out = applyAtcIdentity(exportRoster(roster, fmt), fmt, id);
			expect(out).toContain('+ PLAYER NAME: Ada Lovelace');
			expect(out).toContain('+ TEAM NAME: The Engines');
			expect(out).not.toContain('+ PLAYER NAME: —');
			expect(out).not.toContain('+ TEAM NAME: —');
		});
	}

	it('leaves the em-dash placeholder when a value is blank', () => {
		const out = applyAtcIdentity(exportRoster(roster, 'atc-2026-compact'), 'atc-2026-compact', {
			playerName: '   ',
			teamName: 'The Engines',
		});
		expect(out).toContain('+ PLAYER NAME: —');
		expect(out).toContain('+ TEAM NAME: The Engines');
	});

	it('strips newlines from the entered value (single-line header)', () => {
		const out = applyAtcIdentity(exportRoster(roster, 'atc-2026-full'), 'atc-2026-full', {
			playerName: 'Ada\nLovelace',
			teamName: '',
		});
		expect(out).toContain('+ PLAYER NAME: Ada Lovelace');
	});

	it('is a verbatim no-op for non-ATC formats', () => {
		for (const fmt of ['newrecruit-wtc-compact', 'newrecruit-simple', 'roster-json', 'rosterizer'] as ExportFormat[]) {
			const base = exportRoster(roster, fmt);
			expect(applyAtcIdentity(base, fmt, id)).toBe(base);
		}
	});

	it('touches only the two identity lines, not the rest of the header', () => {
		const base = exportRoster(roster, 'atc-2026-compact');
		const out = applyAtcIdentity(base, 'atc-2026-compact', id);
		const diff = base.split('\n').filter((line, i) => line !== out.split('\n')[i]);
		expect(diff.every((l) => l.startsWith('+ PLAYER NAME:') || l.startsWith('+ TEAM NAME:'))).toBe(true);
		expect(diff).toHaveLength(2);
	});
});
