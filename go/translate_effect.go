package wh40kdc

import (
	"regexp"
	"strconv"
	"strings"
)

// Humanize an Ability-DSL effect tree into natural English. ASCII-only, pinned
// byte-for-byte by conformance/effect-translation. Go mirror of
// python .../translate/effect.py.

var containerTypes = map[string]bool{
	"sequence": true, "choice": true, "dice-gated": true, "dice-pool-allocation": true, "select-units": true,
}

// selectUnitsSubject renders "up to 3 friendly Orks Vehicle units" for select-units.
func selectUnitsSubject(sel map[string]any) string {
	var kws []string
	for _, k := range getStrList(sel, "keywords") {
		kws = append(kws, titleCase(k))
	}
	kw := strings.Join(kws, " ")
	if kw != "" {
		kw = " " + kw
	}
	noun := "units"
	if ejstr(sel["max_count"]) == "1" {
		noun = "unit"
	}
	return "up to " + ejstr(sel["max_count"]) + " " + ejstr(sel["owner"]) + kw + " " + noun
}

// ejstr is the effect module's _jstr (lists join with ", "; numbers without .0).
func ejstr(v any) string {
	switch x := v.(type) {
	case nil:
		return "?"
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = ejstr(e)
		}
		return strings.Join(parts, ", ")
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x
	case float64:
		return numStr(x)
	}
	return numStr(v)
}

var titleSmall = map[string]bool{
	"of": true, "or": true, "and": true, "the": true, "a": true, "an": true,
	"to": true, "in": true, "on": true, "for": true, "with": true,
}

func titleCase(s string) string {
	words := strings.Split(dekebab(s), " ")
	out := make([]string, len(words))
	for i, w := range words {
		if w == "" {
			out[i] = w
		} else if i > 0 && titleSmall[strings.ToLower(w)] {
			out[i] = strings.ToLower(w)
		} else {
			out[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(out, " ")
}

// abilityGrantLabels are curated display labels for granted-ability ids whose
// Title-Cased slug reads wrong. The slug encodes the mechanic
// (charge-after-advance); the label is the published name players know
// (Advance & Charge). Mirror of ABILITY_GRANT_LABELS in
// tools/src/translate/effect.ts; applied only by the ability-grant describer.
var abilityGrantLabels = map[string]string{
	"charge-after-advance":   "Advance & Charge",
	"charge-after-fallback":  "Fall Back & Charge",
	"charge-after-disembark": "Charge After Disembarking",
}

// grantLabel returns the curated label for a granted ability id, else Title Case.
func grantLabel(id string) string {
	if label, ok := abilityGrantLabels[id]; ok {
		return label
	}
	return titleCase(id)
}

// antiRe splits an "anti-<x>"/"anti <x>" keyword; antiRatedRe peels the trailing
// rating ("titanic 3+" -> "titanic", "3"). Both case-insensitive, mirroring the TS.
var antiRe = regexp.MustCompile(`(?i)^anti[\s-]+(.*)$`)
var antiRatedRe = regexp.MustCompile(`(?i)^(.*?)[\s-]*(\d+)\s*(?:\+|plus)?$`)

func bracketKeyword(k any) string {
	raw := strings.TrimSpace(ejstr(k))
	if anti := antiRe.FindStringSubmatch(raw); anti != nil {
		if m := antiRatedRe.FindStringSubmatch(anti[1]); m != nil {
			return "[ANTI-" + strings.ToUpper(strings.TrimSpace(dekebab(m[1]))) + " " + m[2] + "+]"
		}
		return "[ANTI-" + strings.ToUpper(strings.TrimSpace(dekebab(anti[1]))) + "]"
	}
	return "[" + strings.ToUpper(dekebab(raw)) + "]"
}

var dRe = regexp.MustCompile(`[dD]`)

func diceCase(v any) string { return dRe.ReplaceAllString(ejstr(v), "D") }

var testNames = map[string]string{"battle-shock": "Battle-shock", "desperate-escape": "Desperate Escape"}

func testName(test any) string {
	t := ejstr(test)
	if v, ok := testNames[t]; ok {
		return v
	}
	return titleCase(t)
}

var statNames = map[string]string{
	"M": "Move", "T": "Toughness", "Sv": "Save", "W": "Wounds", "A": "Attacks",
	"Ld": "Leadership", "OC": "Objective Control", "S": "Strength", "WS": "Weapon Skill",
	"BS": "Ballistic Skill", "AP": "Armour Penetration", "D": "Damage", "Range": "Range",
}

func statName(stat any) string {
	s := ejstr(stat)
	if v, ok := statNames[s]; ok {
		return v
	}
	return titleCase(s)
}

func poolName(pool any) string {
	p := ejstr(pool)
	if strings.ToLower(p) == "cp" {
		return "CP"
	}
	return titleCase(p)
}

var rollNames = map[string]string{
	"hit": "Hit", "wound": "Wound", "charge": "Charge", "damage": "Damage",
	"advance": "Advance", "save": "Saving throw", "leadership": "Leadership",
}

func rollName(roll any) string {
	r := ejstr(roll)
	if v, ok := rollNames[r]; ok {
		return v
	}
	return titleCase(r)
}

var unitsBoundaryRe = regexp.MustCompile(` units\b`)

func isPlural(subj string) bool {
	return unitsBoundaryRe.MatchString(subj) ||
		strings.HasPrefix(subj, "all ") ||
		strings.HasPrefix(subj, "enemy units") || strings.HasPrefix(subj, "friendly units")
}

var pluralVerbs = map[string]string{
	"has": "have", "is": "are", "gets": "get", "gains": "gain",
	"suffers": "suffer", "retains": "retain", "makes": "make",
	"passes": "pass", "fails": "fail", "treats": "treat",
}

func ev(subj, singular string) string {
	if !isPlural(subj) {
		return singular
	}
	if v, ok := pluralVerbs[singular]; ok {
		return v
	}
	return strings.TrimSuffix(singular, "s")
}

func pronoun(subj string) string {
	if isPlural(subj) {
		return "their"
	}
	return "its"
}

// resurrectionPlacement renders a resurrection placement modifier
// ("using its Deep Strike ability" / "at a battlefield edge").
func resurrectionPlacement(placement any) string {
	if placement == nil {
		return ""
	}
	switch ejstr(placement) {
	case "deep-strike":
		return "using its Deep Strike ability"
	case "battlefield-edge":
		return "at a battlefield edge"
	case "closest-to-destruction":
		return "as close as possible to where it was destroyed"
	case "unengaged":
		return "not within Engagement Range of any enemy units"
	default:
		return "via " + dekebab(ejstr(placement))
	}
}

// resurrectionTiming renders a resurrection timing modifier ("when it is set up").
func resurrectionTiming(timing any) string {
	if timing == nil {
		return ""
	}
	switch ejstr(timing) {
	case "next-movement-phase":
		return "in your next Movement phase"
	case "end-of-phase":
		return "at the end of the phase"
	default:
		return dekebab(ejstr(timing))
	}
}

func subject(target any, ctx map[string]any) string {
	within := " nearby"
	if ri := ctx["range_inches"]; ri != nil {
		within = " within " + ejstr(ri) + "\""
	} else if ctx["engagement_range"] == true {
		within = " within Engagement Range"
	}
	switch target {
	case "self", "bearer":
		return "this model"
	case "unit":
		return "the unit"
	case "attached-unit":
		return "the unit this model leads"
	case "target":
		return "the target"
	case "attacker":
		return "the attacking unit"
	case "defender":
		return "your unit"
	case "all-friendly":
		return "all friendly units"
	case "all-enemy":
		return "all enemy units"
	case "friendly-within-aura":
		return "friendly units" + within
	case "enemy-within-aura":
		return "enemy units" + within
	}
	return "the unit"
}

func possessive(s string) string {
	if strings.HasSuffix(s, "s") {
		return s + "'"
	}
	return s + "'s"
}

func esigned(operation, value any) string {
	positive := operation == "add" || operation == "improve"
	sign := 1
	if !positive {
		sign = -1
	}
	if isNumber(value) {
		n, _ := num(value)
		if n < 0 {
			sign = -sign
			value = -n
		}
	}
	if sign > 0 {
		return "+" + ejstr(value)
	}
	return "-" + ejstr(value)
}

// poolThreshold renders the per-die success phrase ("4+", "6", "3 or less") for
// a mortal-wounds dice pool — no leading "a", as it follows "for each".
func poolThreshold(comp string, threshold any) string {
	th := ejstr(threshold)
	switch comp {
	case "lte":
		return th + " or less"
	case "gt":
		return "more than " + th
	case "lt":
		return "less than " + th
	case "eq":
		return th
	}
	return th + "+"
}

func formatComparison(comp string, threshold any) string {
	th := ejstr(threshold)
	switch comp {
	case "gte":
		return "a " + th + "+"
	case "lte":
		return "a " + th + " or less"
	case "gt":
		return "greater than " + th
	case "lt":
		return "less than " + th
	case "eq":
		return "exactly " + th
	}
	return "a " + th + "+"
}

func durationClauses(duration any) (string, string) {
	switch duration {
	case "phase":
		return "", "until the end of the phase"
	case "turn":
		return "", "until the end of the turn"
	case "battle":
		return "", "for the rest of the battle"
	case "battle-round":
		return "", "until the end of the battle round"
	case "until-next-command-phase":
		return "", "until your next Command phase"
	case "one-use":
		return "once per battle", ""
	}
	return "", ""
}

var leadingIfRe = regexp.MustCompile(`^if `)

// negatedTargetKeywords renders "against a unit that is not a Monster or Vehicle"
// from a run of excluded target keywords.
func negatedTargetKeywords(keywords []string) string {
	return "against a unit that is not a " + strings.Join(keywords, " or ")
}

// capWord capitalizes the first character and lowercases the rest (MONSTER -> Monster).
func capWord(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + strings.ToLower(s[1:])
}

// notWrappedTargetKeyword returns the keyword of a `not`-wrapping-a-single-
// `target-has-keyword` operand, else "", false. The aura-subject exclusion
// encoding, distinct from the bare negated form.
func notWrappedTargetKeyword(op map[string]any) (string, bool) {
	if op["operator"] != "not" {
		return "", false
	}
	operands, ok := asList(op["operands"])
	if !ok || len(operands) != 1 {
		return "", false
	}
	inner, _ := asMap(operands[0])
	if inner["type"] != "target-has-keyword" || inner["negated"] == true {
		return "", false
	}
	mp, _ := getMap(inner, "parameters")
	return ejstr(mp["keyword"]), true
}

// excludedTargetKeywords renders "(excluding Monster or Vehicle units)" from a run
// of `not`-wrapped target-keyword exclusions.
func excludedTargetKeywords(keywords []string) string {
	capped := make([]string, len(keywords))
	for i, k := range keywords {
		capped[i] = capWord(k)
	}
	return "(excluding " + strings.Join(capped, " or ") + " units)"
}

// joinAndLeadIns joins the operands of an `and` lead-in. Two exclusion encodings
// collapse: a run of bare-negated target-has-keyword becomes "against a unit that
// is not a X or Y", and a run of `not`-wrapped target-has-keyword becomes
// "(excluding X or Y units)". Either attaches to the preceding clause with a
// space; all other operands join with ", ".
func joinAndLeadIns(operands []any) string {
	var parts []string
	for i := 0; i < len(operands); {
		om, _ := asMap(operands[i])
		if om["negated"] == true && om["type"] == "target-has-keyword" {
			var kws []string
			for i < len(operands) {
				m, _ := asMap(operands[i])
				if m["negated"] == true && m["type"] == "target-has-keyword" {
					mp, _ := getMap(m, "parameters")
					kws = append(kws, ejstr(mp["keyword"]))
					i++
				} else {
					break
				}
			}
			parts = append(parts, negatedTargetKeywords(kws))
			continue
		}
		if kw, ok := notWrappedTargetKeyword(om); ok {
			kws := []string{kw}
			i++
			for i < len(operands) {
				m, _ := asMap(operands[i])
				if k2, ok2 := notWrappedTargetKeyword(m); ok2 {
					kws = append(kws, k2)
					i++
				} else {
					break
				}
			}
			parts = append(parts, excludedTargetKeywords(kws))
			continue
		}
		parts = append(parts, conditionLeadIn(om))
		i++
	}
	acc := ""
	for _, part := range parts {
		switch {
		case acc == "":
			acc = part
		case strings.HasPrefix(part, "against ") || strings.HasPrefix(part, "(excluding "):
			acc = acc + " " + part
		default:
			acc = acc + ", " + part
		}
	}
	return acc
}

func conditionLeadIn(c map[string]any) string {
	operands, _ := asList(c["operands"])
	switch c["operator"] {
	case "and":
		if len(operands) > 0 {
			return joinAndLeadIns(operands)
		}
	case "or":
		if len(operands) > 0 {
			parts := make([]string, len(operands))
			for i, o := range operands {
				om, _ := asMap(o)
				parts[i] = conditionLeadIn(om)
			}
			return strings.Join(parts, " or ")
		}
	case "not":
		if len(operands) > 0 {
			parts := make([]string, len(operands))
			for i, o := range operands {
				om, _ := asMap(o)
				parts[i] = leadingIfRe.ReplaceAllString(conditionLeadIn(om), "")
			}
			return "unless " + strings.Join(parts, " or ")
		}
	}
	p, _ := getMap(c, "parameters")
	if p == nil {
		p = map[string]any{}
	}
	// Negated keyword gates read as an exclusion clause, not the generic "if not …".
	if c["negated"] == true && c["type"] == "target-has-keyword" {
		return negatedTargetKeywords([]string{ejstr(p["keyword"])})
	}
	if c["negated"] == true && c["type"] == "unit-has-keyword" {
		return "unless the unit has the " + ejstr(p["keyword"]) + " keyword"
	}
	if c["negated"] == true {
		return "if " + describeCondition(c)
	}
	switch c["type"] {
	case "phase-is":
		return "during the " + titleCase(ejstr(p["phase"])) + " phase"
	case "is-attached":
		kw := ""
		if p["keyword"] != nil && truthy(p["keyword"]) {
			kw = ejstr(p["keyword"]) + " "
		}
		return "after being attached to a " + kw + "unit"
	case "timing-is":
		return describeTiming(p["timing"])
	case "player-turn-is":
		switch p["turn"] {
		case "your-turn":
			return "in your turn"
		case "opponent-turn":
			return "in the opponent's turn"
		}
		return "in either player's turn"
	case "model-is-leader":
		return "while this model leads a unit"
	case "charged-this-turn":
		return "if the unit charged this turn"
	case "advanced-this-turn":
		return "if the unit Advanced this turn"
	case "disembarked-from-transport":
		return "if the unit disembarked from a Transport this turn"
	case "faction-rule-active":
		return "while the " + titleCase(ejstr(p["rule"])) + " is active"
	case "battle-round":
		return "during the first " + ejstr(p["max"]) + " battle rounds"
	case "remained-stationary":
		return "if the unit Remained Stationary"
	case "target-has-keyword":
		return "against " + ejstr(p["keyword"]) + " targets"
	case "unit-has-keyword":
		return "if the unit has the " + ejstr(p["keyword"]) + " keyword"
	case "is-battle-shocked":
		return "while the unit is Battle-shocked"
	case "unit-below-half-strength":
		if p["subject"] == "target" {
			return "while the target unit is below half strength"
		}
		return "while the unit is below half strength"
	case "unit-below-starting-strength":
		return "while the unit is below its starting strength"
	case "has-lost-wounds":
		return "while the model has lost wounds"
	case "attack-is-type":
		if p["comparison"] == "strength-greater-than-toughness" {
			return "when this attack's Strength is greater than the target's Toughness"
		}
		if p["comparison"] != nil {
			return "when " + dekebab(ejstr(p["comparison"]))
		}
		return "while making " + ejstr(p["attack_type"]) + " attacks"
	case "destroyed-by-attack-type":
		return "when destroyed by a " + ejstr(p["attack_type"]) + " attack"
	case "opponent-unit-within-range":
		var where string
		switch {
		case p["weapon_name"] != nil:
			where = "range of " + dekebab(ejstr(p["weapon_name"]))
		case p["range_multiplier"] != nil:
			where = "half range of its ranged weapons"
		case p["range"] == "engagement":
			where = "engagement range"
		default:
			where = ejstr(p["range"]) + "\""
		}
		return "while an enemy unit is within " + where
	case "engagement-state":
		if p["state"] == nil {
			return "while the unit is within Engagement Range"
		}
		st := cstr(p["state"])
		switch st {
		case "on-battlefield":
			return "while the unit is on the battlefield"
		case "embarked":
			return "while the unit is embarked"
		case "engaged", "within-engagement-range", "in-engagement-range":
			return "while the unit is within Engagement Range"
		case "not-in-engagement-range", "not-within-engagement-range":
			return "while the unit is not within Engagement Range"
		}
		return "while the unit is " + dekebab(st)
	case "disposition-matches":
		d := cstr(p["disposition"])
		if d == "strategic-reserves" {
			return "while the unit is in Strategic Reserves"
		}
		return "while the unit's disposition is " + dekebab(d)
	case "fights-first":
		return "while the unit has the Fights First ability"
	}
	return "if " + describeCondition(c)
}

// describeRuleState renders a `rule-state` effect: a named rule switched on/off
// for the subject. The faction-rule + suppressed path reproduces the legacy
// `forgo-faction-rule` wording verbatim; core-rule slugs get natural
// action/benefit phrasing; keyword/ability kinds fall back to a regular
// gains/loses-the-X clause. Pinned across the four ports by conformance.
func describeRuleState(m map[string]any, subj string) string {
	direction := ejstr(m["direction"])
	kind := ejstr(m["rule_kind"])
	rule := ejstr(m["rule"])
	granted := direction == "granted"

	if kind == "faction-rule" && !granted {
		scope := ""
		if m["scope"] != nil {
			scope = " this " + dekebab(ejstr(m["scope"]))
		}
		cost := ""
		if c, ok := m["cost"].(map[string]any); ok && c["dice"] != nil {
			frm := ""
			if c["from"] != nil {
				if ejstr(c["from"]) == rule {
					frm = " from that roll"
				} else {
					frm = " from the " + titleCase(ejstr(c["from"])) + " roll"
				}
			}
			cost = ", using a " + dekebab(ejstr(c["dice"])) + frm
		}
		return "forgo activating " + titleCase(rule) + scope + cost
	}
	if kind == "faction-rule" {
		return subj + " " + ev(subj, "gains") + " " + titleCase(rule)
	}

	switch rule {
	case "benefit-of-cover":
		if granted {
			return subj + " " + ev(subj, "has") + " the Benefit of Cover"
		}
		return subj + " cannot benefit from Cover"
	case "charge":
		if granted {
			return subj + " can charge"
		}
		return subj + " cannot charge"
	case "advance":
		if granted {
			return subj + " can Advance"
		}
		return subj + " cannot Advance"
	case "fall-back":
		if granted {
			return subj + " can Fall Back"
		}
		return subj + " cannot Fall Back"
	case "ordered-retreat":
		// GW frames this lever by its effect on Desperate Escape tests: suppressing
		// Ordered Retreat forces the tests; granting it (e.g. while Battle-shocked)
		// exempts the unit. Mirrors the `desperate-escape` slug wording.
		if granted {
			return subj + " " + ev(subj, "is") + " not affected by Desperate Escape tests"
		}
		return subj + " must take Desperate Escape tests"
	case "fire-overwatch":
		if granted {
			return subj + " can fire Overwatch"
		}
		return subj + " cannot fire Overwatch"
	case "overwatch-against-bearer":
		if granted {
			return "your opponent can target " + subj + " with Overwatch"
		}
		return "your opponent cannot target " + subj + " with Overwatch"
	case "desperate-escape":
		if granted {
			return subj + " must take Desperate Escape tests"
		}
		return subj + " " + ev(subj, "is") + " not affected by Desperate Escape tests"
	}

	noun := "ability"
	if kind == "keyword" {
		noun = "keyword"
	}
	if granted {
		return subj + " " + ev(subj, "gains") + " the " + titleCase(rule) + " " + noun
	}
	return subj + " " + ev(subj, "loses") + " the " + titleCase(rule) + " " + noun
}

func describeAttackRestriction(m map[string]any, subj string) string {
	if m["restriction"] == nil && m["restriction_type"] == nil && m["attack_type"] != nil {
		return subj + " cannot " + ejstr(m["attack_type"])
	}
	raw := m["restriction"]
	if raw == nil {
		raw = m["restriction_type"]
	}
	slug := ejstr(raw)
	var rng string
	hasRng := m["range"] != nil
	if hasRng {
		rng = ejstr(m["range"])
	}
	switch slug {
	case "worsen-incoming-ap":
		amount := "1"
		if m["value"] != nil {
			amount = ejstr(m["value"])
		}
		return "each time an attack targets " + subj + ", worsen the Armour Penetration of that attack by " + amount
	case "cannot-be-targeted-unless-closest-or-within-12":
		return subj + " can only be targeted if it is the closest eligible target or within 12\""
	case "targeting-range-limit":
		r := "?"
		if hasRng {
			r = rng
		}
		return subj + " can only target enemy units within " + r + "\""
	case "reinforcement-denial":
		r := "?"
		if hasRng {
			r = rng
		}
		return "enemy units cannot be set up from Reserves within " + r + "\" of " + subj
	case "must-be-warlord":
		return "this model must be your Warlord"
	case "cannot-be-warlord":
		return "this model cannot be your Warlord"
	case "unique-unit-limit":
		return "you can include only one of this unit in your army"
	case "no-charge":
		return subj + " cannot charge"
	}
	rngClause := ""
	if hasRng {
		rngClause = " (within " + rng + "\")"
	}
	return subj + ": " + dekebab(slug) + rngClause
}

func mod(e map[string]any) map[string]any {
	m, _ := getMap(e, "modifier")
	if m == nil {
		return map[string]any{}
	}
	return m
}

// scaleOf is the humanized noun for a scaling `of` dimension.
var scaleOf = map[string]string{
	"enemy-models-in-range":    "enemy models",
	"friendly-models-in-range": "friendly models",
	"models-in-bearer-unit":    "models in this unit",
	"enemy-units-in-range":     "enemy units",
	"wounds-lost":              "wounds lost",
}

// scalingClause renders a `scaling` block as a trailing "for every …" clause.
func scalingClause(s map[string]any) string {
	of := cstr(s["of"])
	ofText := scaleOf[of]
	if ofText == "" {
		ofText = dekebab(of)
	}
	c := "for every " + cstr(s["per"]) + " " + ofText
	if s["within_inches"] != nil {
		c += " within " + cstr(s["within_inches"]) + "\""
	}
	if s["round"] == "up" {
		c += " (rounding up)"
	}
	if s["max_value"] != nil {
		c += " (to a maximum of " + cstr(s["max_value"]) + ")"
	}
	return c
}

// passthroughPhrase maps a movement-modifier passthrough enum to its human phrase.
var passthroughPhrase = map[string]string{
	"non-titanic-models": "non-Titanic models",
	"friendly-vehicles":  "friendly Vehicle models",
	"friendly-monsters":  "friendly Monster models",
	"terrain-le-4":       `terrain features 4" or lower`,
	"tall-terrain":       `terrain features over 4"`,
	"all-terrain":        "terrain features",
}

// moveNoun maps a move-kind token to its display noun (for applies_to_moves).
var moveNoun = map[string]string{
	"normal":    "Normal",
	"advance":   "Advance",
	"fall-back": "Fall Back",
	"charge":    "Charge",
}

// andList renders an Oxford-free conjunction list ("a", "a and b", "a, b and c").
func andList(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	case 2:
		return items[0] + " and " + items[1]
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}

// inchClause renders a trailing inches clause for a movement distance (int or
// dice string); "" when absent or zero.
func inchClause(dist any) string {
	if dist == nil {
		return ""
	}
	s := diceCase(ejstr(dist))
	if s == "0" {
		return ""
	}
	return " " + s + "\""
}

// parseNumber mirrors TS Number()/Python float(): a JSON number, or a numeric
// string. Returns (value, true) only when the value parses cleanly.
func parseNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// movementClause renders a closed movement-modifier `modifier` as one
// lowercase-initial clause. Mirror of _movement_clause in
// python .../translate/effect.py.
func movementClause(m map[string]any, subj string) string {
	kind := m["move_type"]
	dist := m["distance"]
	inches := inchClause(dist)
	ofUpTo := ""
	if inches != "" {
		ofUpTo = " of up to" + inches
	}
	var moveKinds string
	if moves, ok := asList(m["applies_to_moves"]); ok {
		parts := make([]string, len(moves))
		for i, x := range moves {
			xs := ejstr(x)
			if n, ok := moveNoun[xs]; ok {
				parts[i] = n
			} else {
				parts[i] = dekebab(xs)
			}
		}
		moveKinds = andList(parts)
	}

	// Pure traversal capability (no move kind): passthrough / vertical / ignore-vertical.
	if kind == nil {
		var parts []string
		if pt, ok := asList(m["passthrough"]); ok && len(pt) > 0 {
			phrases := make([]string, len(pt))
			for i, p := range pt {
				ps := ejstr(p)
				if ph, ok := passthroughPhrase[ps]; ok {
					phrases[i] = ph
				} else {
					phrases[i] = dekebab(ps)
				}
			}
			parts = append(parts, strings.Join(phrases, " and "))
		}
		var clause string
		if len(parts) > 0 {
			over := ""
			if m["vertical_limit"] != nil {
				over = " (up to " + ejstr(m["vertical_limit"]) + "\" high)"
			}
			clause = subj + " can move over " + strings.Join(parts, " and ") + over + " as though they were not there"
		} else if truthy(m["ignore_vertical"]) {
			clause = subj + " ignores vertical distances when it moves"
		} else {
			clause = subj + " " + ev(subj, "has") + " a movement capability"
		}
		if m["excludes_keyword"] != nil {
			clause += " (excluding " + titleCase(ejstr(m["excludes_keyword"])) + " models)"
		}
		if moveKinds != "" {
			clause += ", during its " + moveKinds + " moves"
		}
		return clause
	}

	switch ejstr(kind) {
	case "scout":
		return "before the first battle round, " + subj + " can make a Scout move" + ofUpTo
	case "infiltrate":
		return subj + " " + ev(subj, "has") + " the Infiltrators ability"
	case "advance":
		return "add " + diceCase(ejstr(dist)) + " to " + possessive(subj) + " Advance rolls"
	case "pile-in":
		i := inches
		if i == "" {
			i = " 3\""
		}
		return subj + " can Pile In up to" + i
	case "consolidation":
		i := inches
		if i == "" {
			i = " 3\""
		}
		return subj + " can Consolidate up to" + i
	case "surge":
		return subj + " can make a Surge move" + ofUpTo
	case "shoot-and-scoot":
		if inches != "" {
			return subj + " can shoot and then make a Normal move" + ofUpTo
		}
		return subj + " can Shoot and Scoot"
	case "reactive":
		label := ""
		if m["name"] != nil {
			label = " (" + ejstr(m["name"]) + ")"
		}
		return subj + " can make a Reactive move" + ofUpTo + label
	case "redeploy":
		if marker, ok := getMap(m, "marker"); ok && marker != nil {
			if marker["location"] != nil {
				who := "units"
				if marker["unit_filter"] != nil {
					who = ejstr(marker["unit_filter"]) + " units"
				}
				return who + " can be set up on " + ejstr(marker["location"])
			}
			what := "markers"
			if marker["affected"] != nil {
				what = ejstr(marker["affected"])
			}
			return what + " can be repositioned" + inches
		}
		if truthy(m["to_reserves"]) {
			n := subj
			if m["max_units"] != nil {
				n = "up to " + ejstr(m["max_units"]) + " units"
			}
			return n + " can be placed into Strategic Reserves"
		}
		return subj + " can be redeployed" + inches
	}
	// normal / default
	if n, ok := parseNumber(dist); ok && n < 0 {
		return possessive(subj) + " Move characteristic is reduced by " + numStr(-n) + "\""
	}
	if moveKinds != "" {
		return "add" + inches + " to " + possessive(subj) + " " + moveKinds + " moves"
	}
	return subj + " can make a Normal move" + ofUpTo
}

// auraClause renders a generic aura `modifier` as one lowercase-initial clause.
// Mirror of _aura_clause in python .../translate/effect.py.
func auraClause(e, m map[string]any, ctx map[string]any) string {
	// Range-extension of a named aura (e.g. Gift of Poxes: contagion +3").
	if m["range_bonus"] != nil {
		named := ""
		if m["of"] != nil {
			named = titleCase(ejstr(m["of"])) + " "
		}
		return "the range of this model's " + named + "abilities is increased by " + ejstr(m["range_bonus"]) + "\""
	}
	var rangeText string
	hasRange := false
	if rng, ok := asList(m["range"]); ok {
		parts := make([]string, len(rng))
		for i, r := range rng {
			parts[i] = ejstr(r) + "\""
		}
		rangeText = strings.Join(parts, "/") + " (by battle round)"
		hasRange = true
	} else if m["range"] != nil {
		rangeText = ejstr(m["range"]) + "\""
		hasRange = true
	}
	who := "each enemy unit"
	if e["target"] == "friendly-within-aura" {
		who = "each friendly unit"
	}
	within := who
	if hasRange {
		within = who + " within " + rangeText
	}
	if inner, ok := getMap(m, "effect"); ok && inner != nil {
		ctxCopy := map[string]any{}
		for k, val := range ctx {
			ctxCopy[k] = val
		}
		return within + " " + describeEffectInline(inner, ctxCopy)
	}
	return within + " is affected"
}

// describeEffectInline wraps the leaf/container switch to weave on any `scaling` block.
func describeEffectInline(e map[string]any, ctx map[string]any) string {
	base := describeEffectInlineBase(e, ctx)
	if scaling, ok := getMap(e, "scaling"); ok && scaling != nil {
		return base + " " + scalingClause(scaling)
	}
	return base
}

func describeEffectInlineBase(e map[string]any, ctx map[string]any) string {
	if ctx == nil {
		ctx = map[string]any{}
	}
	m := mod(e)
	subj := subject(e["target"], ctx)
	switch e["type"] {
	case "stat-modifier":
		scope := ""
		if m["attack_type"] != nil && truthy(m["attack_type"]) {
			scope = " (" + ejstr(m["attack_type"]) + ")"
		}
		if m["stat"] == nil {
			return "modify " + possessive(subj) + " characteristics" + scope
		}
		if m["operation"] == "set" {
			return "modify " + possessive(subj) + " " + statName(m["stat"]) + " characteristic to " + ejstr(m["value"]) + scope
		}
		val := m["value"]
		verb := "add"
		if m["operation"] == "subtract" || m["operation"] == "worsen" {
			verb = "subtract"
		}
		if isNumber(val) {
			n, _ := num(val)
			if n < 0 {
				if verb == "add" {
					verb = "subtract"
				} else {
					verb = "add"
				}
				val = -n
			}
		}
		prep := "from"
		if verb == "add" {
			prep = "to"
		}
		return verb + " " + ejstr(val) + " " + prep + " " + possessive(subj) + " " + statName(m["stat"]) + " characteristic" + scope
	case "roll-modifier":
		ctxNote := ""
		if m["context"] != nil && truthy(m["context"]) {
			ctxNote = " (" + ejstr(m["context"]) + ")"
		}
		roll := rollName(m["roll"])
		if m["critical_on"] != nil {
			crit := "Critical Hits"
			if m["roll"] == "wound" {
				crit = "Critical Wounds"
			}
			return subj + " " + ev(subj, "scores") + " " + crit + " on " + roll + " rolls of " + ejstr(m["critical_on"]) + "+"
		}
		if m["operation"] == "set" {
			return subj + " can change " + roll + " rolls to a " + ejstr(m["value"])
		}
		if m["value"] == nil {
			return dekebab(ejstr(m["operation"])) + " " + possessive(subj) + " " + roll + " rolls" + ctxNote
		}
		return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to " + roll + " rolls" + ctxNote
	case "re-roll":
		noun := rollName(m["roll"])
		which := "the " + noun + " roll"
		if m["subset"] == "ones" {
			which = "a " + noun + " roll of 1"
		}
		return "you can re-roll " + which
	case "mortal-wounds":
		return describeMortalWounds(e, m, subj, ctx)
	case "feel-no-pain":
		vs := ""
		if m["scope"] == "mortal" {
			vs = " against mortal wounds"
		}
		return subj + " " + ev(subj, "has") + " the Feel No Pain " + ejstr(m["threshold"]) + "+ ability" + vs
	case "ward":
		th := m["threshold"]
		if th == nil {
			th = m["value"]
		}
		return subj + " " + ev(subj, "has") + " the Ward " + ejstr(th) + "+ ability"
	case "invulnerable-save":
		sv := m["invuln_sv"]
		if sv == nil {
			sv = m["value"]
		}
		if sv == nil {
			sv = m["threshold"]
		}
		return subj + " " + ev(subj, "has") + " a " + ejstr(sv) + "+ invulnerable save"
	case "keyword-grant":
		var kw string
		kwArr, kwIsList := asList(m["keywords"])
		switch {
		case m["anti_keyword"] != nil:
			kw = "[ANTI-" + strings.ToUpper(dekebab(ejstr(m["anti_keyword"]))) + " " + ejstr(m["anti_threshold"]) + "+]"
		case kwIsList:
			parts := make([]string, len(kwArr))
			for i, k := range kwArr {
				parts[i] = bracketKeyword(k)
			}
			kw = strings.Join(parts, " and ")
		case m["value"] != nil:
			// Rated keyword carried structurally (Sustained Hits N / Rapid Fire N / Melta N).
			var k any = "keywords"
			if m["keyword"] != nil {
				k = m["keyword"]
			}
			kw = "[" + strings.ToUpper(dekebab(ejstr(k))) + " " + ejstr(m["value"]) + "]"
		default:
			var k any = "keywords"
			if m["keyword"] != nil {
				k = m["keyword"]
			}
			kw = bracketKeyword(k)
		}
		if m["weapon_name"] != nil {
			return possessive(subj) + " " + ejstr(m["weapon_name"]) + " gains " + kw
		}
		if m["weapon_type"] != nil {
			return possessive(subj) + " " + ejstr(m["weapon_type"]) + " weapons gain " + kw
		}
		return possessive(subj) + " weapons gain " + kw
	case "ability-grant":
		grant := m["grant_type"]
		if grant == nil {
			grant = m["ability_id"]
		}
		cap := ""
		if m["capacity"] != nil {
			cap = " (" + ejstr(m["capacity"]) + ")"
		}
		if grant != nil {
			return subj + " " + ev(subj, "gains") + " the " + grantLabel(ejstr(grant)) + " ability" + cap
		}
		return subj + " " + ev(subj, "gains") + " an ability" + cap
	case "movement-modifier":
		return movementClause(m, subj)
	case "aura":
		return auraClause(e, m, ctx)
	case "damage-reduction":
		var rv any = m["reduction"]
		if rv == nil {
			rv = m["amount"]
		}
		if rv == nil {
			rv = m["value"]
		}
		r := ejstr(rv)
		var how string
		switch r {
		case "half":
			how = "halve the Damage of that attack"
		case "to-zero":
			how = "reduce the Damage of that attack to 0"
		default:
			how = "reduce the Damage of that attack by " + r
		}
		return "each time an attack targets " + subj + ", " + how
	case "resurrection":
		count := "1"
		if m["count"] != nil {
			count = diceCase(m["count"])
		}
		var w any = "full"
		if m["wounds_remaining"] != nil {
			w = m["wounds_remaining"]
		}
		var parts []string
		if p := resurrectionPlacement(m["placement"]); p != "" {
			parts = append(parts, p)
		}
		if t := resurrectionTiming(m["timing"]); t != "" {
			parts = append(parts, t)
		}
		tailClause := ""
		if len(parts) > 0 {
			tailClause = " " + strings.Join(parts, " ")
		}
		// A self/bearer resurrection reads as the model returning, not "returning a model to itself".
		if e["target"] == "self" || e["target"] == "bearer" {
			return subj + " " + ev(subj, "is") + " set up again" + tailClause + " with " + ejstr(w) + " wounds remaining"
		}
		noun := "destroyed models"
		if count == "1" {
			noun = "destroyed model"
		}
		return "return " + count + " " + noun + " to " + subj + " with " + ejstr(w) + " wounds" + tailClause
	case "model-destruction":
		count := "1"
		if m["count"] != nil {
			count = diceCase(m["count"])
		}
		noun := "models"
		if count == "1" {
			noun = "model"
		}
		return "destroy " + count + " " + noun + " in " + subj
	case "rule-state":
		return describeRuleState(m, subj)
	case "cp-gain":
		var a any = float64(1)
		if m["amount"] != nil {
			a = m["amount"]
		}
		return "you gain " + ejstr(a) + "CP"
	case "cp-refund":
		strat := "one Stratagem"
		if m["stratagem"] != nil {
			strat = "the " + titleCase(ejstr(m["stratagem"])) + " Stratagem"
		}
		return "you can use " + strat + " on " + subj + " for 0CP"
	case "resource-gain":
		amount := m["amount"]
		if amount == nil {
			amount = m["value"]
		}
		pool := m["pool_id"]
		if pool == nil {
			pool = m["resource"]
		}
		return "you gain " + ejstr(amount) + " " + poolName(pool)
	case "resource-spend":
		amount := m["amount"]
		if amount == nil {
			amount = m["value"]
		}
		pool := m["pool_id"]
		if pool == nil {
			pool = m["resource"]
		}
		return "spend " + ejstr(amount) + " " + poolName(pool)
	case "leadership-modifier":
		hasTest := m["test"] != nil
		if hasTest && m["operation"] == nil {
			return subj + " must take a " + testName(m["test"]) + " test"
		}
		if hasTest && m["operation"] == "re-roll" {
			return subj + " can re-roll " + testName(m["test"]) + " tests"
		}
		if hasTest && m["value"] != nil {
			verb := "subtract"
			prep := "from"
			if m["operation"] == "add" {
				verb, prep = "add", "to"
			}
			return verb + " " + ejstr(m["value"]) + " " + prep + " the " + testName(m["test"]) + " test of " + subj
		}
		if m["operation"] != nil && m["value"] != nil {
			positive := m["operation"] == "add" || m["operation"] == "improve"
			verb, prep := "subtract", "from"
			if positive {
				verb, prep = "add", "to"
			}
			return verb + " " + ejstr(m["value"]) + " " + prep + " the Leadership characteristic of " + subj
		}
		return "modify " + possessive(subj) + " Leadership characteristic"
	case "fight-first":
		return subj + " " + ev(subj, "has") + " the Fights First ability"
	case "fight-last":
		return subj + " " + ev(subj, "has") + " the Fights Last ability"
	case "fight-on-death":
		if subj == "this model" {
			return "each time this model is destroyed, it can fight before being removed from play"
		}
		return "each time a model in " + subj + " is destroyed, it can fight before being removed from play"
	case "shoot-on-death":
		if subj == "this model" {
			return "each time this model is destroyed, it can shoot before being removed from play"
		}
		return "each time a model in " + subj + " is destroyed, it can shoot before being removed from play"
	case "unit-keyword":
		name := titleCase(ejstr(m["keyword_id"]))
		val := ""
		if m["value"] != nil {
			val = " " + ejstr(m["value"])
		}
		return subj + " " + ev(subj, "has") + " the " + name + val + " ability"
	case "unit-keyword-grant":
		return ejstr(m["to_keywords"]) + " units gain the " + ejstr(m["keyword"]) + " keyword"
	case "deep-strike":
		if m["min_distance"] != nil {
			return subj + " " + ev(subj, "has") + " the Deep Strike ability and can be set up more than " + ejstr(m["min_distance"]) + "\" from enemy models"
		}
		return subj + " has the Deep Strike ability"
	case "strategic-reserves-arrival":
		return subj + " can arrive from Strategic Reserves regardless of mission rules"
	case "remove-battle-shock":
		return subj + " " + ev(subj, "is") + " no longer Battle-shocked"
	case "auto-result":
		r := m["result"]
		if m["test"] != nil {
			switch r {
			case "pass":
				return subj + " automatically " + ev(subj, "passes") + " " + testName(m["test"]) + " tests"
			case "fail":
				return subj + " automatically " + ev(subj, "fails") + " " + testName(m["test"]) + " tests"
			}
			return subj + " " + ev(subj, "treats") + " " + testName(m["test"]) + " tests as " + ejstr(r)
		}
		roll := rollName(m["roll"])
		switch r {
		case "pass":
			return possessive(subj) + " " + roll + " rolls automatically succeed"
		case "fail":
			return possessive(subj) + " " + roll + " rolls automatically fail"
		}
		return possessive(subj) + " " + roll + " rolls count as " + ejstr(r)
	case "firing-deck":
		return subj + " " + ev(subj, "has") + " Firing Deck " + ejstr(m["value"])
	case "disembark-after-move":
		return "units can disembark from " + subj + " after it has moved"
	case "fallback-and-act":
		return subj + " " + ev(subj, "is") + " eligible to shoot and declare a charge in a turn in which it Fell Back"
	case "engagement-passthrough":
		if truthy(m["no_end_in_engagement"]) {
			return subj + " can move through enemy models, but cannot end that move within Engagement Range of any enemy unit"
		}
		return subj + " can move through enemy models"
	case "attack-restriction":
		return describeAttackRestriction(m, subj)
	case "objective-control-modifier":
		if truthy(m["sticky"]) {
			return subj + " " + ev(subj, "retains") + " control of objective markers even after no models remain in range, until the enemy retakes them (sticky objectives)"
		}
		if m["operation"] == "halve" {
			return "halve the Objective Control characteristic of " + subj
		}
		if m["operation"] != nil {
			return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to " + pronoun(subj) + " Objective Control characteristic"
		}
		return "modify " + possessive(subj) + " Objective Control characteristic"
	case "bs-modifier":
		return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to Ballistic Skill"
	case "charge-roll-modifier":
		return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to Charge rolls"
	case "terrain-area-tag":
		return "the terrain area is marked as " + dekebab(ejstr(m["tag"]))
	case "objective-tag":
		return "the objective is marked as " + dekebab(ejstr(m["tag"]))
	case "unit-tag":
		return subj + " " + ev(subj, "is") + " marked as " + dekebab(ejstr(m["tag"]))
	case "conditional":
		cond, _ := getMap(e, "condition")
		inner, _ := getMap(e, "effect")
		return conditionLeadIn(cond) + ", " + describeEffectInline(inner, ctx)
	case "sequence":
		var parts []string
		for _, s := range getList(e, "steps") {
			sm, _ := asMap(s)
			parts = append(parts, describeEffectInline(sm, ctx))
		}
		return strings.Join(parts, "; ")
	case "choice":
		label := ""
		if cl, ok := e["choice_label"].(string); ok && cl != "" {
			label = " (" + titleCase(cl) + ")"
		}
		var opts []string
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			opts = append(opts, describeEffectInline(om, ctx))
		}
		return "select one of the following" + label + ": " + strings.Join(opts, " / ")
	case "dice-gated":
		return describeDiceGatedInline(e, ctx)
	case "dice-pool-allocation":
		return describeDicePoolInline(e, ctx)
	case "select-units":
		sel, _ := getMap(e, "selector")
		inner, _ := getMap(e, "effect")
		return "select " + selectUnitsSubject(sel) + ": " + describeEffectInline(inner, ctx)
	}
	t := "unknown"
	if e["type"] != nil {
		t = ejstr(e["type"])
	}
	return "[" + t + "]"
}

func describeMortalWounds(e, m map[string]any, subj string, ctx map[string]any) string {
	rng := m["range"]
	if rng == nil {
		rng = m["range_inches"]
	}
	if rng == nil {
		rng = ctx["range_inches"]
	}
	subjMW := subj
	if e["target"] == "enemy-within-aura" && rng != nil {
		subjMW = "each enemy unit within " + ejstr(rng) + "\""
	}
	verb := ev(subjMW, "suffers")
	if strings.HasPrefix(subjMW, "each ") {
		verb = "suffers"
	}
	// Dice-pool form: N dice rolled, each success worth `mortal_per_success`
	// mortal wounds (distinct from a flat count).
	if m["mortal_per_success"] != nil {
		per := ejstr(m["mortal_per_success"])
		perNoun := "mortal wounds"
		if per == "1" {
			perNoun = "mortal wound"
		}
		comp := "gte"
		if c, ok := m["comparison"].(string); ok && c != "" {
			comp = c
		}
		hit := poolThreshold(comp, m["threshold"])
		die := diceCase(m["dice"])
		// Per-model pool: one die per model in this/the target unit.
		if m["per_model"] != nil {
			where := "this unit"
			if m["per_model"] == "target" {
				where = "the target unit"
			}
			return "roll one " + die + " for each model in " + where + ": for each " + hit + ", " + subjMW + " " + verb + " " + per + " " + perNoun
		}
		return "roll " + die + ": for each " + hit + ", " + subjMW + " " + verb + " " + per + " " + perNoun
	}
	var a *string
	switch {
	case m["count"] != nil:
		s := ejstr(m["count"])
		a = &s
	case m["amount"] != nil:
		s := ejstr(m["amount"])
		a = &s
	case m["dice"] != nil:
		s := diceCase(m["dice"])
		a = &s
	case truthy(m["table"]) || truthy(m["amount_table"]):
		s := "a number of"
		a = &s
	}
	if a == nil && m["trigger"] != nil {
		return "when this model is destroyed, " + subjMW + " " + verb + " mortal wounds (" + titleCase(ejstr(m["trigger"])) + ")"
	}
	amt := "?"
	if a != nil {
		amt = *a
	}
	noun := "mortal wounds"
	if amt == "1" {
		noun = "mortal wound"
	}
	return subjMW + " " + verb + " " + amt + " " + noun
}

func describeDiceGatedInline(e map[string]any, ctx map[string]any) string {
	comp := "gte"
	if c, ok := e["comparison"].(string); ok && c != "" {
		comp = c
	}
	cmp := formatComparison(comp, e["threshold"])
	success := "nothing happens"
	if os, ok := getMap(e, "on_success"); ok && os != nil {
		success = describeEffectInline(os, ctx)
	}
	fail := ""
	if of, ok := getMap(e, "on_fail"); ok && of != nil {
		fail = "; otherwise, " + describeEffectInline(of, ctx)
	}
	return "roll one " + diceCase(e["dice"]) + ": on " + cmp + ", " + success + fail
}

func describeDicePoolInline(e map[string]any, ctx map[string]any) string {
	poolText := "?"
	if pool, ok := getMap(e, "pool"); ok && pool != nil {
		poolText = ejstr(pool["count"]) + ejstr(pool["die"])
	}
	var opts []string
	for _, o := range getList(e, "options") {
		om, _ := asMap(o)
		req, _ := getMap(om, "requirement")
		eff, _ := getMap(om, "effect")
		opts = append(opts, ejstr(om["name"])+" ("+ejstr(req["type"])+" of "+ejstr(req["min_value"])+"+): "+describeEffectInline(eff, ctx))
	}
	return "roll " + poolText + ": " + strings.Join(opts, " / ")
}

func describeEffect(e map[string]any, depth int, ctx map[string]any) string {
	if ctx == nil {
		ctx = map[string]any{}
	}
	indent := strings.Repeat("  ", depth)
	arrow := ""
	if depth > 0 {
		arrow = "-> "
	}
	switch e["type"] {
	case "conditional":
		inner, _ := getMap(e, "effect")
		cond, _ := getMap(e, "condition")
		if inner != nil && containerTypes[getStr(inner, "type")] {
			return indent + capitalize(conditionLeadIn(cond)) + ":\n" + describeEffect(inner, depth+1, ctx)
		}
		return indent + arrow + capitalize(conditionLeadIn(cond)) + ", " + describeEffectInline(inner, ctx) + "."
	case "sequence":
		var parts []string
		for _, s := range getList(e, "steps") {
			sm, _ := asMap(s)
			parts = append(parts, describeEffect(sm, depth, ctx))
		}
		return strings.Join(parts, "\n")
	case "choice":
		label := ""
		if cl, ok := e["choice_label"].(string); ok && cl != "" {
			label = " (" + titleCase(cl) + ")"
		}
		var opts []string
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			opts = append(opts, indent+"  - "+capitalize(describeEffectInline(om, ctx))+".")
		}
		return indent + "Select one of the following" + label + ":\n" + strings.Join(opts, "\n")
	case "dice-gated":
		comp := "gte"
		if c, ok := e["comparison"].(string); ok && c != "" {
			comp = c
		}
		cmp := formatComparison(comp, e["threshold"])
		success := "nothing happens"
		if os, ok := getMap(e, "on_success"); ok && os != nil {
			success = describeEffectInline(os, ctx)
		}
		fail := ""
		if of, ok := getMap(e, "on_fail"); ok && of != nil {
			fail = "; otherwise, " + describeEffectInline(of, ctx)
		}
		return indent + arrow + "Roll one " + diceCase(e["dice"]) + ": on " + cmp + ", " + success + fail + "."
	case "dice-pool-allocation":
		poolText := "?"
		if pool, ok := getMap(e, "pool"); ok && pool != nil {
			poolText = ejstr(pool["count"]) + ejstr(pool["die"])
		}
		lines := []string{indent + arrow + "Roll " + poolText + " (max " + ejstr(e["max_activations"]) + " activations):"}
		for _, optAny := range getList(e, "options") {
			opt, _ := asMap(optAny)
			req, _ := getMap(opt, "requirement")
			eff, _ := getMap(opt, "effect")
			lines = append(lines, indent+"  - "+ejstr(opt["name"])+": need "+ejstr(req["type"])+" of "+ejstr(req["min_value"])+"+ -> "+describeEffectInline(eff, ctx))
		}
		return strings.Join(lines, "\n")
	case "select-units":
		sel, _ := getMap(e, "selector")
		inner, _ := getMap(e, "effect")
		lead := "Select " + selectUnitsSubject(sel)
		if inner != nil && containerTypes[getStr(inner, "type")] {
			return indent + arrow + lead + ":\n" + describeEffect(inner, depth+1, ctx)
		}
		return indent + arrow + lead + ": " + describeEffectInline(inner, ctx) + "."
	}
	return indent + arrow + capitalize(describeEffectInline(e, ctx)) + "."
}

func describeAppliesTo(a map[string]any) string {
	if a == nil {
		return ""
	}
	required := getStrList(a, "required_keywords")
	excluded := getStrList(a, "excluded_keywords")
	if len(required) == 0 && len(excluded) == 0 {
		return ""
	}
	base := "all units"
	if len(required) > 0 {
		base = "units with " + strings.Join(required, ", ")
	}
	exc := ""
	if len(excluded) > 0 {
		exc = " (excluding " + strings.Join(excluded, ", ") + ")"
	}
	return "Applies to: " + base + exc + "."
}

func assembleSentence(parts []string) string {
	var nonEmpty []string
	for _, p := range parts {
		if p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	body := strings.Join(nonEmpty, ", ")
	if body == "" {
		return ""
	}
	period := "."
	if strings.HasSuffix(body, ".") || strings.HasSuffix(body, ":") {
		period = ""
	}
	return capitalize(body) + period
}

// usageClause renders an ability-level usage limit as a front-of-sentence lead
// clause ("once per turn", "twice per battle per unit").
func usageClause(u map[string]any) string {
	n := 1
	if isNumber(u["count"]) {
		f, _ := num(u["count"])
		n = int(f)
	}
	var base string
	switch ejstr(u["frequency"]) {
	case "once-per-turn":
		base = "once per turn"
	case "once-per-phase":
		base = "once per phase"
	case "once-per-command-phase":
		base = "once per Command phase"
	case "once-per-opponent-turn":
		base = "once per opponent's turn"
	case "first-this-battle":
		base = "the first time this battle"
	case "first-time-this-phase":
		base = "the first time this phase"
	case "n-per-battle":
		switch n {
		case 1:
			base = "once per battle"
		case 2:
			base = "twice per battle"
		default:
			base = ejstr(float64(n)) + " times per battle"
		}
	default:
		base = dekebab(ejstr(u["frequency"]))
	}
	if u["per"] != nil {
		base += " per " + ejstr(u["per"])
	}
	return base
}

// describeReactiveTrigger renders a reactive ability trigger as a front-of-sentence
// lead clause ("an enemy unit ends a move within 9\" of this model"). Distinct from
// the scoring-card describeTrigger (different shape; same package).
func describeReactiveTrigger(t map[string]any) string {
	s := eventClause(t["event"])
	if prox, _ := getMap(t, "proximity"); prox != nil && prox["range"] != nil {
		of := "this unit"
		switch prox["of"] {
		case "attached-unit":
			of = "the unit this model leads"
		case "self", "bearer":
			of = "this model"
		}
		s += " within " + ejstr(prox["range"]) + "\" of " + of
	}
	if t["condition"] != nil {
		cond, _ := asMap(t["condition"])
		s += ", if " + describeCondition(cond)
	}
	return s
}

var auraSlugRe = regexp.MustCompile(`^aura-(\d+)$`)

// auraRadius returns the aura radius in inches: an explicit range_inches, else the
// integer baked into a standard aura-<n> slug (aura-6 -> 6), else nil. Per the
// scope schema, aura-6/9/12 carry the radius in the slug and leave range_inches
// null; only aura-custom sets range_inches. Non-aura ranges yield nil, keeping
// subject()'s " nearby" fallback.
func auraRadius(scope map[string]any) any {
	if scope["range_inches"] != nil {
		return scope["range_inches"]
	}
	if r, ok := scope["range"].(string); ok {
		if m := auraSlugRe.FindStringSubmatch(r); m != nil {
			n, _ := strconv.ParseFloat(m[1], 64)
			return n
		}
	}
	return nil
}

func renderTopLevel(e map[string]any, scope map[string]any, usage map[string]any, trigger map[string]any) string {
	ctx := map[string]any{
		"range_inches":     auraRadius(scope),
		"engagement_range": scope["range"] == "engagement-range",
	}
	durLead, trail := durationClauses(scope["duration"])
	// An explicit usage limit supersedes the duration's coarse "once per battle" lead.
	lead := durLead
	if usage != nil && usage["frequency"] != nil {
		lead = usageClause(usage)
	}
	// A reactive trigger opens the sentence ("Each time …").
	trig := ""
	if trigger != nil && trigger["event"] != nil {
		trig = describeReactiveTrigger(trigger)
	}
	if e["type"] == "conditional" {
		inner, _ := getMap(e, "effect")
		cond, _ := getMap(e, "condition")
		leadIn := conditionLeadIn(cond)
		if inner != nil && containerTypes[getStr(inner, "type")] {
			header := joinNonEmpty([]string{trig, lead, leadIn, trail}, ", ")
			return capitalize(header) + ":\n" + describeEffect(inner, 1, ctx)
		}
		return assembleSentence([]string{trig, lead, leadIn, trail, describeEffectInline(inner, ctx)})
	}
	if containerTypes[getStr(e, "type")] {
		block := describeEffect(e, 0, ctx)
		dur := lead
		if dur == "" {
			dur = trail
		}
		head := joinNonEmpty([]string{trig, dur}, ", ")
		if head != "" {
			return capitalize(head) + ":\n" + block
		}
		return block
	}
	return assembleSentence([]string{trig, lead, trail, describeEffectInline(e, ctx)})
}

func joinNonEmpty(parts []string, sep string) string {
	var ne []string
	for _, p := range parts {
		if p != "" {
			ne = append(ne, p)
		}
	}
	return strings.Join(ne, sep)
}

// describeAbility renders the full natural-English text for an ability
// (effect + woven scope/duration, plus a trailing Applies to: line).
func describeAbility(a map[string]any) string {
	core := ""
	if eff, ok := getMap(a, "effect"); ok && eff != nil {
		scope, _ := getMap(a, "scope")
		if scope == nil {
			scope = map[string]any{}
		}
		usage, _ := getMap(a, "usage")
		trigger, _ := getMap(a, "trigger")
		core = renderTopLevel(eff, scope, usage, trigger)
	}
	at, _ := getMap(a, "applies_to")
	applies := describeAppliesTo(at)
	return joinNonEmpty([]string{core, applies}, "\n")
}
