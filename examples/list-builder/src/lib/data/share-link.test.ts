/**
 * Unit tests for the backend-free share link: gzip+base64url round-trip, plus a
 * full builder → roster-json → link → import round-trip against the embedded data.
 */
import { describe, it, expect } from "vitest";
import { decodeShareToken } from "@alpaca-software/40kdc-data";
import {
	encodeShareLink,
	decodeShareLink,
	tryEncodeCompactShareLink,
} from "./share-link";
import {
	emptyBuilderState,
	builderToRosterJson,
	rosterTextToBuilderState,
	unitRaw,
	defaultLoadout,
	unitsForFaction,
	detachmentsForFaction,
} from "./builder";

describe("share-link codec", () => {
	it("round-trips an arbitrary string (incl. non-ASCII) and stays URL-safe", () => {
		const json = JSON.stringify({ name: "Tést 🔒", units: [{ id: "x" }] });
		const token = encodeShareLink(json);
		expect(token).not.toMatch(/[+/=]/); // base64url, no padding
		expect(decodeShareLink(token)).toBe(json);
	});

	it("returns null on malformed input rather than throwing", () => {
		expect(decodeShareLink("")).toBeNull();
		expect(decodeShareLink("not%%valid")).toBeNull();
	});
});

describe("share-link list round-trip", () => {
	it("rebuilds the same list from its share link", () => {
		const state = emptyBuilderState();
		state.factionId = "adeptus-astartes";
		const firstDet = detachmentsForFaction("adeptus-astartes")[0]?.id;
		state.detachmentIds = firstDet ? [firstDet] : [];
		const unit = unitsForFaction("adeptus-astartes").find(
			(u) => (u.points?.length ?? 0) > 0 && u.model_count != null,
		)!;
		const raw = unitRaw(unit.id)!;
		const modelCount = raw.model_count?.min ?? 1;
		state.units = [
			{
				key: "k0",
				datasheetId: unit.id,
				modelCount,
				loadout: defaultLoadout(raw, modelCount),
				enhancementId: null,
				isWarlord: false,
			},
		];

		const json = builderToRosterJson(state);
		const decoded = decodeShareLink(encodeShareLink(json));
		expect(decoded).toBe(json);

		const back = rosterTextToBuilderState(decoded!, "Shared list", null);
		expect(back).not.toBeNull();
		expect(back!.factionId).toBe(state.factionId);
		expect(back!.detachmentIds).toEqual(state.detachmentIds);
		expect(back!.units).toHaveLength(1);
		expect(back!.units[0].datasheetId).toBe(unit.id);
	});
});

describe("compact share links", () => {
	it("returns the codec error instead of throwing for an unknown registry id", () => {
		const result = tryEncodeCompactShareLink(
			{ ...emptyBuilderState(), factionId: "not-in-registry" },
			"https://list-builder.example/",
		);

		expect(result).toEqual({
			ok: false,
			error:
				'share registry has no faction id "not-in-registry" — run `npm run registry:build` and commit the result',
		});
	});

	it("encodes the imported Norn Silliness roster with The Red Terror's current weapon id", () => {
		const roster = {
			name: "Norn Silliness",
			source: { format: "roster-json", generated_by: "test" },
			faction_id: "Tyranids",
			detachments: [],
			battle_size: "strike-force",
			force_disposition: "take-and-hold",
			points: {
				declared_limit: 2000,
				detachment_cap: 3,
				total_reported: 130,
				total_computed: 130,
			},
			units: [
				{
					ref: {
						id: "the-red-terror",
						raw_name: "The Red Terror",
						resolved: true,
						candidates: [],
					},
					model_count: 1,
					points: 130,
					is_warlord: true,
					enhancement: null,
					enhancement_points: null,
					wargear: [
						{
							ref: {
								id: "gaping-maw",
								raw_name: "Gaping maw",
								resolved: true,
								candidates: [],
							},
							count: 1,
						},
						{
							ref: {
								id: "scything-talons-the-red-terror",
								raw_name: "Scything talons",
								resolved: true,
								candidates: [],
							},
							count: 1,
						},
					],
					leader_attachment: null,
				},
			],
			game_version: { edition: "11th", dataslate: "pre-launch-provisional" },
			diagnostics: {
				resolved_units: 1,
				unresolved_units: 0,
				resolved_weapons: 2,
				unresolved_weapons: 0,
				warnings: [],
			},
		};
		const state = rosterTextToBuilderState(
			JSON.stringify(roster),
			"Norn Silliness",
			"take-and-hold",
		);

		expect(state).not.toBeNull();
		if (!state) throw new Error("expected the canonical roster to import");
		expect(state.factionId).toBe("tyranids");
		expect(state.units).toHaveLength(1);
		expect(state.units[0].datasheetId).toBe("the-red-terror");
		expect(state.units[0].loadout.get("scything-talons-the-red-terror")).toBe(1);

		const result = tryEncodeCompactShareLink(state, "https://list-builder.example/");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.link).toMatch(/^https:\/\/list-builder\.example\/#l=/);

		const decoded = decodeShareToken(result.link.split("#l=")[1]);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) throw new Error("expected the compact token to decode");
		expect(decoded.list.factionId).toBe("tyranids");
		expect(decoded.list.units[0].datasheetId).toBe("the-red-terror");
		expect(decoded.list.units[0].loadout).toContainEqual([
			"scything-talons-the-red-terror",
			1,
		]);
	});
});
