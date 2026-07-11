package wh40kdc

import "strings"

// Yellowscribe (.ros) serializer — Go mirror of tools/src/export/yellowscribe.ts
// (and python .../export/yellowscribe.py). Emits a BattleScribe-compatible
// `.ros` XML document that Yellowscribe (github.com/ThePants999/Yellowscribe)
// ingests to build an army in Tabletop Simulator.
//
// Unlike the eight Dataset-free serializers this one is **Dataset-backed**: the
// Roster carries only entity ids/counts/points, but Yellowscribe needs full
// datasheet stat lines, weapon profiles, keywords, and ability text for its TTS
// tooltips. So it resolves each unit against the Dataset (faction-first, then
// any) and reads stats/weapons/abilities off the linked views. Output is
// byte-identical to the TS oracle, pinned by
// conformance/roster/*/expected.yellowscribe.ros.
//
// **IP boundary.** No GW rules prose is emitted — ability descriptions come from
// the conformance-pinned DSL describer (describeAbility); the dataset stores no
// rules text. Everything else is a numeric fact or a community-authored name.
//
// **Determinism.** No sorting; ordered data is read from the record's slices
// (profiles, weapon_ids, ability_ids, keywords, faction_keywords,
// loadout_groups) — never from a Go map. Attribute order is a fixed
// [][2]string. Integer stats render plain (numStr drops the ".0"); string
// StatValues pass through verbatim. Deterministic synthetic ids
// (unit{i} / unit{i}-m{g} / unit{i}-m{g}-w{w}), one shared XML escaper.

// BattleScribe's Warhammer 40,000 10th-edition game-system id — Yellowscribe
// rejects a roster whose gameSystemId isn't this.
const ysGameSystemID = "sys-352e-adc2-7639-d6a9"
const ysGameSystemName = "Warhammer 40,000"

// ---------------------------------------------------------------------------
// Minimal deterministic XML tree + renderer (no library — a library would
// reorder attributes or normalise whitespace, breaking byte-parity).
// ---------------------------------------------------------------------------

type ysEl struct {
	tag      string
	attrs    [][2]string
	children []*ysEl
	// text is a single text body, mutually exclusive with children. nil = none.
	text *string
}

func ysNode(tag string, attrs [][2]string, children []*ysEl) *ysEl {
	return &ysEl{tag: tag, attrs: attrs, children: children}
}

func ysLeaf(tag string, attrs [][2]string, text string) *ysEl {
	return &ysEl{tag: tag, attrs: attrs, text: &text}
}

// ysEscText escapes text content: & < >.
func ysEscText(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

// ysEscAttr escapes an attribute value: & < > ".
func ysEscAttr(s string) string {
	return strings.ReplaceAll(ysEscText(s), "\"", "&quot;")
}

func ysRenderAttrs(attrs [][2]string) string {
	var b strings.Builder
	for _, kv := range attrs {
		b.WriteString(" ")
		b.WriteString(kv[0])
		b.WriteString("=\"")
		b.WriteString(ysEscAttr(kv[1]))
		b.WriteString("\"")
	}
	return b.String()
}

func ysRender(node *ysEl, depth int) string {
	indent := strings.Repeat("  ", depth)
	open := "<" + node.tag + ysRenderAttrs(node.attrs)
	if node.text != nil {
		return indent + open + ">" + ysEscText(*node.text) + "</" + node.tag + ">"
	}
	if len(node.children) == 0 {
		return indent + open + "/>"
	}
	parts := make([]string, len(node.children))
	for i, c := range node.children {
		parts[i] = ysRender(c, depth+1)
	}
	return indent + open + ">\n" + strings.Join(parts, "\n") + "\n" + indent + "</" + node.tag + ">"
}

// ---------------------------------------------------------------------------
// Stat-line rendering (datasheet conventions; deterministic across ports).
// ---------------------------------------------------------------------------

// ysFmtMove renders movement: append the inch mark unless the stored value
// already carries one.
func ysFmtMove(m any) string {
	s := numStr(m)
	if strings.HasSuffix(s, "\"") {
		return s
	}
	return s + "\""
}

// ysFmtTarget renders a target-number stat (Sv, Ld, BS, WS): append +.
func ysFmtTarget(v any) string {
	return numStr(v) + "+"
}

// ysKeywordLabel renders a weapon keyword's display label: Anti-Infantry 4+,
// Rapid Fire 1, or a bare Devastating Wounds.
func ysKeywordLabel(name string, parameters any) string {
	if pm, ok := asMap(parameters); ok && pm != nil {
		tk, tkOK := pm["target_keyword"].(string)
		th := pm["threshold"]
		if tkOK && ysIsNumOrStr(th) {
			return name + "-" + tk + " " + numStr(th) + "+"
		}
		if value, has := pm["value"]; has && value != nil {
			return name + " " + numStr(value)
		}
	}
	return name
}

// ysIsNumOrStr mirrors the TS `typeof th === "number" || "string"` guard (JSON
// numbers decode to float64 in Go).
func ysIsNumOrStr(v any) bool {
	switch v.(type) {
	case float64, string:
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Profile builders.
// ---------------------------------------------------------------------------

// ysUnitStatProfiles builds the <profile typeName="Unit"> stat line(s) — one per
// unit stat profile (degrading/wound-track units carry several).
func ysUnitStatProfiles(view *UnitView) []*ysEl {
	profiles := getList(view.Raw, "profiles")
	out := make([]*ysEl, 0, len(profiles))
	for i, pAny := range profiles {
		p, _ := asMap(pAny)
		name := view.Name()
		if n, ok := p["name"].(string); ok && n != "" {
			name = n
		} else if i != 0 {
			name = view.Name() + " (" + itoa(i+1) + ")"
		}
		out = append(out, ysNode("profile", [][2]string{{"name", name}, {"typeName", "Unit"}}, []*ysEl{
			ysNode("characteristics", nil, []*ysEl{
				ysLeaf("characteristic", [][2]string{{"name", "M"}}, ysFmtMove(p["M"])),
				ysLeaf("characteristic", [][2]string{{"name", "T"}}, numStr(p["T"])),
				ysLeaf("characteristic", [][2]string{{"name", "SV"}}, ysFmtTarget(p["Sv"])),
				ysLeaf("characteristic", [][2]string{{"name", "W"}}, numStr(p["W"])),
				ysLeaf("characteristic", [][2]string{{"name", "LD"}}, ysFmtTarget(p["Ld"])),
				ysLeaf("characteristic", [][2]string{{"name", "OC"}}, numStr(p["OC"])),
			}),
		}))
	}
	return out
}

func ysAbilityProfile(name, description string) *ysEl {
	return ysNode("profile", [][2]string{{"name", name}, {"typeName", "Abilities"}}, []*ysEl{
		ysNode("characteristics", nil, []*ysEl{
			ysLeaf("characteristic", [][2]string{{"name", "Description"}}, description),
		}),
	})
}

// ysAbilityProfiles builds the <profile typeName="Abilities"> entries: the invuln
// save (a numeric fact) followed by each ability's describer-rendered text.
func ysAbilityProfiles(view *UnitView) []*ysEl {
	var out []*ysEl
	profiles := getList(view.Raw, "profiles")
	if len(profiles) > 0 {
		if p0, ok := asMap(profiles[0]); ok {
			if invuln, has := p0["invuln_sv"]; has && invuln != nil {
				out = append(out, ysAbilityProfile("Invulnerable Save", numStr(invuln)+"+ invulnerable save"))
			}
		}
	}
	for _, ability := range view.Abilities() {
		out = append(out, ysAbilityProfile(ability.Name(), describeAbility(ability.Raw)))
	}
	return out
}

// ysWeaponProfiles builds a weapon's <profile> list — one per weapon stat profile.
// Ranged weapons carry BS, melee carry WS and a Melee range.
func ysWeaponProfiles(weapon *WeaponView) []*ysEl {
	ranged := getStr(weapon.Raw, "type") == "ranged"
	typeName := "Melee Weapons"
	if ranged {
		typeName = "Ranged Weapons"
	}
	profiles := getList(weapon.Raw, "profiles")
	out := make([]*ysEl, 0, len(profiles))
	for i, pAny := range profiles {
		p, _ := asMap(pAny)
		stats, _ := asMap(p["stats"])
		var rng string
		if ranged {
			r := p["range"]
			if r == nil {
				r = float64(0)
			}
			rng = ysFmtMove(r)
		} else {
			rng = "Melee"
		}
		skillName := "WS"
		var skill any = stats["WS"]
		if ranged {
			skillName = "BS"
			skill = stats["BS"]
		}
		skillText := "N/A"
		if _, ok := skill.(float64); ok {
			skillText = ysFmtTarget(skill)
		}
		var labels []string
		for _, k := range weapon.keywordsAt(i) {
			kv := k["keyword"].(*WeaponKeywordView)
			labels = append(labels, ysKeywordLabel(kv.Name(), k["parameters"]))
		}
		keywords := strings.Join(labels, ", ")
		out = append(out, ysNode("profile", [][2]string{{"name", getStr(p, "name")}, {"typeName", typeName}}, []*ysEl{
			ysNode("characteristics", nil, []*ysEl{
				ysLeaf("characteristic", [][2]string{{"name", "Range"}}, rng),
				ysLeaf("characteristic", [][2]string{{"name", "A"}}, numStr(stats["A"])),
				ysLeaf("characteristic", [][2]string{{"name", skillName}}, skillText),
				ysLeaf("characteristic", [][2]string{{"name", "S"}}, numStr(stats["S"])),
				ysLeaf("characteristic", [][2]string{{"name", "AP"}}, numStr(stats["AP"])),
				ysLeaf("characteristic", [][2]string{{"name", "D"}}, numStr(stats["D"])),
				ysLeaf("characteristic", [][2]string{{"name", "Keywords"}}, keywords),
			}),
		}))
	}
	return out
}

// ---------------------------------------------------------------------------
// Selection tree.
// ---------------------------------------------------------------------------

// ysResolveUnit resolves a roster unit to its datasheet view, faction-first then
// any. Mirror of TS resolveRosterUnit.
func ysResolveUnit(unit map[string]any, ds *Dataset, factionID string) *UnitView {
	ref := refOf(unit)
	id, ok := ref["id"].(string)
	if !ok || id == "" {
		return nil
	}
	if factionID != "" {
		if v, ok := ds.Units.GetInFaction(id, factionID); ok {
			return v
		}
	}
	if v, ok := ds.Units.GetAny(id); ok {
		return v
	}
	return nil
}

// ysResolveWeapon resolves a wargear ref to its weapon view, faction-first.
func ysResolveWeapon(w map[string]any, ds *Dataset, factionID string) *WeaponView {
	ref := refOf(w)
	id, ok := ref["id"].(string)
	if !ok || id == "" {
		return nil
	}
	if factionID != "" {
		if v, ok := ds.Weapons.GetInFaction(id, factionID); ok {
			return v
		}
	}
	if v, ok := ds.Weapons.GetAny(id); ok {
		return v
	}
	return nil
}

// ysUpgradeSelection builds one weapon <selection type="upgrade">. number is the
// TOTAL across the group's models (perModel × groupModelCount) — Yellowscribe
// divides it back out by the model count.
func ysUpgradeSelection(id string, weapon *WeaponView, totalCount int) *ysEl {
	return ysNode("selection",
		[][2]string{{"id", id}, {"name", weapon.Name()}, {"type", "upgrade"}, {"number", itoa(totalCount)}},
		[]*ysEl{ysNode("profiles", nil, ysWeaponProfiles(weapon))},
	)
}

// ysModelSelection builds one <selection type="model"> for a loadout group, with
// its per-model weapons nested as upgrade selections.
func ysModelSelection(idBase, modelName string, modelCount int, wargear []any, ds *Dataset, factionID string) *ysEl {
	var upgrades []*ysEl
	for wi, wAny := range wargear {
		w, _ := asMap(wAny)
		weapon := ysResolveWeapon(w, ds, factionID)
		if weapon == nil {
			continue // unresolved weapon — skip (already flagged in diagnostics)
		}
		upgrades = append(upgrades, ysUpgradeSelection(idBase+"-w"+itoa(wi), weapon, asInt(w["count"])*modelCount))
	}
	var children []*ysEl
	if len(upgrades) > 0 {
		children = append(children, ysNode("selections", nil, upgrades))
	}
	return ysNode("selection",
		[][2]string{{"id", idBase}, {"name", modelName}, {"type", "model"}, {"number", itoa(modelCount)}},
		children,
	)
}

// ysModelSelections builds the nested <selection type="model"> list for a unit —
// one per loadout group, falling back to a single group over the flat wargear[]
// (whose counts are already unit totals).
func ysModelSelections(unit map[string]any, unitID string, view *UnitView, ds *Dataset, factionID string) []*ysEl {
	groups := getList(unit, "loadout_groups")
	var out []*ysEl
	if len(groups) > 0 {
		for gi, gAny := range groups {
			g, _ := asMap(gAny)
			modelName := view.Name()
			if mn, ok := g["model_name"].(string); ok && mn != "" {
				modelName = mn
			}
			out = append(out, ysModelSelection(unitID+"-m"+itoa(gi), modelName, asInt(g["count"]), getList(g, "wargear"), ds, factionID))
		}
		return out
	}
	// Fallback: single group over the flat wargear (per-model = total / model_count).
	return []*ysEl{ysModelSelection(unitID+"-m0", view.Name(), asInt(unit["model_count"]), unitWargear(unit), ds, factionID)}
}

// ysCategoriesEl builds the unit categories: faction keywords (prefixed
// "Faction: ") then general keywords, in stored order. nil when empty.
func ysCategoriesEl(view *UnitView) *ysEl {
	var cats []*ysEl
	for _, k := range getStrList(view.Raw, "faction_keywords") {
		cats = append(cats, ysNode("category", [][2]string{{"name", "Faction: " + k}}, nil))
	}
	for _, k := range getStrList(view.Raw, "keywords") {
		cats = append(cats, ysNode("category", [][2]string{{"name", k}}, nil))
	}
	if len(cats) == 0 {
		return nil
	}
	return ysNode("categories", nil, cats)
}

// ysUnitSelection builds one unit <selection type="unit">. nil for a unit that
// doesn't resolve against the dataset (no datasheet to emit stats from).
func ysUnitSelection(unit map[string]any, index int, ds *Dataset, factionID string) *ysEl {
	view := ysResolveUnit(unit, ds, factionID)
	if view == nil {
		return nil
	}
	unitID := "unit" + itoa(index)

	profiles := append(ysUnitStatProfiles(view), ysAbilityProfiles(view)...)
	children := []*ysEl{ysNode("profiles", nil, profiles)}

	if cats := ysCategoriesEl(view); cats != nil {
		children = append(children, cats)
	}

	children = append(children, ysNode("selections", nil, ysModelSelections(unit, unitID, view, ds, factionID)))

	return ysNode("selection",
		[][2]string{{"id", unitID}, {"name", getStr(refOf(unit), "raw_name")}, {"type", "unit"}, {"number", "1"}},
		children,
	)
}

// serializeYellowscribe serializes a Roster into Yellowscribe-ingestible
// BattleScribe .ros XML. Go mirror of the TS/Python yellowscribe serializer.
func serializeYellowscribe(roster map[string]any, ds *Dataset) string {
	factionID := getStr(roster, "faction_id")
	factionName := titleCaseIDOr(roster["faction_id"], "Unknown")

	var unitSelections []*ysEl
	for i, uAny := range getList(roster, "units") {
		u, _ := asMap(uAny)
		if sel := ysUnitSelection(u, i, ds, factionID); sel != nil {
			unitSelections = append(unitSelections, sel)
		}
	}

	force := ysNode("force",
		[][2]string{{"id", "force0"}, {"name", factionName}, {"catalogueName", factionName}},
		[]*ysEl{ysNode("selections", nil, unitSelections)},
	)

	rosterEl := ysNode("roster",
		[][2]string{
			{"id", "roster0"},
			{"name", getStr(roster, "name")},
			{"gameSystemId", ysGameSystemID},
			{"gameSystemName", ysGameSystemName},
		},
		[]*ysEl{ysNode("forces", nil, []*ysEl{force})},
	)

	return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" + ysRender(rosterEl, 0) + "\n"
}
