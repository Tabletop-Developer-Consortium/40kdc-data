package wh40kdc

import "strings"

// Humanize an Ability-DSL / scoring condition into plain English. ASCII-only
// with a fixed clause + parameter order, pinned by conformance/scoring-
// translation. Go mirror of python .../translate/condition.py.

func dekebab(s string) string { return strings.ReplaceAll(s, "-", " ") }

// cstr is the condition module's `_str`: null -> "?", else JS String(v).
func cstr(v any) string {
	if v == nil {
		return "?"
	}
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return numStr(x)
	}
	return numStr(v)
}

func countNoun(n any, noun string) string { return cstr(n) + "+ " + noun + "s" }

var timingPhrases = map[string]string{
	"start-of-phase":                  "at the start of the phase",
	"end-of-phase":                    "at the end of the phase",
	"start-of-turn":                   "at the start of the turn",
	"end-of-turn":                     "at the end of the turn",
	"end-of-opponent-turn":            "at the end of the opponent's turn",
	"start-of-battle-round":           "at the start of the battle round",
	"start":                           "at the start of the turn",
	"end":                             "at the end of the turn",
	"command-phase":                   "in the Command phase",
	"shooting-phase":                  "in the Shooting phase",
	"on-model-destroyed":              "each time a model in this unit is destroyed",
	"before-this-model-removed":       "before removing this model from the battlefield",
	"model-destroyed":                 "each time a model in this unit is destroyed",
	"first-model-destroyed":           "the first time a model in this unit is destroyed",
	"first-this-battle":               "the first time this battle",
	"first-time-this-phase":           "the first time this phase",
	"on-unit-destroyed":               "each time this unit is destroyed",
	"on-destroyed":                    "each time this unit is destroyed",
	"enemy-unit-destroyed-in-melee":   "each time an enemy unit is destroyed in melee",
	"in-reserves":                     "while it is in Reserves",
	"game-start-in-reserves":          "if it begins the battle in Reserves",
	"starts-in-strategic-reserves":    "if it starts in Strategic Reserves",
	"deep-strike-setup":               "when it is set up by Deep Strike",
	"deep-strike":                     "when it is set up by Deep Strike",
	"set-up-from-reserves":            "when it arrives from Reserves",
	"arrives-from-strategic-reserves": "when it arrives from Strategic Reserves",
	"reinforcements":                  "when it arrives as Reinforcements",
	"reinforcements-step":             "during the Reinforcements step",
	"post-deployment":                 "after deployment",
	"declare-battle-formations":       "when declaring Battle Formations",
	"normal-move":                     "when it makes a Normal move",
	"advance-move":                    "when it makes an Advance move",
	"advance":                         "when it Advances",
	"fall-back-move":                  "when it makes a Fall Back move",
	"fall-back":                       "when it Falls Back",
	"charge-move":                     "when it makes a Charge move",
	"once-per-battle":                 "once per battle",
	"once-per-phase":                  "once per phase",
	"once-per-opponent-turn":          "once per opponent's turn",
}

func describeTiming(timing any) string {
	t := cstr(timing)
	if v, ok := timingPhrases[t]; ok {
		return v
	}
	if strings.HasPrefix(t, "after-") {
		return "after " + dekebab(t[6:])
	}
	if strings.HasPrefix(t, "on-") {
		return "when " + dekebab(t[3:])
	}
	if strings.HasSuffix(t, "-destroyed") {
		return "each time " + dekebab(t)
	}
	return "at " + dekebab(t)
}

func describeCondition(c map[string]any) string {
	operands, _ := asList(c["operands"])
	switch c["operator"] {
	case "and":
		if len(operands) > 0 {
			return joinConds(operands, " and ")
		}
	case "or":
		if len(operands) > 0 {
			return joinConds(operands, " or ")
		}
	case "not":
		if len(operands) > 0 {
			return "not (" + joinConds(operands, ", ") + ")"
		}
	}

	negate := ""
	if c["negated"] == true {
		negate = "not "
	}
	p, _ := getMap(c, "parameters")
	if p == nil {
		p = map[string]any{}
	}
	ctype, _ := c["type"].(string)

	switch ctype {
	case "phase-is":
		return negate + "during the " + cstr(p["phase"]) + " phase"
	case "timing-is":
		return negate + describeTiming(p["timing"])
	case "player-turn-is":
		whose := "either player's"
		switch p["turn"] {
		case "your-turn":
			whose = "your"
		case "opponent-turn":
			whose = "the opponent's"
		}
		return negate + "in " + whose + " turn"
	case "charged-this-turn":
		return negate + "the unit charged this turn"
	case "advanced-this-turn":
		return negate + "the unit advanced this turn"
	case "remained-stationary":
		return negate + "the unit remained stationary"
	case "unit-below-starting-strength":
		return negate + "the unit is below starting strength"
	case "unit-below-half-strength":
		return negate + "the unit is below half strength"
	case "unit-has-keyword":
		return negate + "the unit has \"" + cstr(p["keyword"]) + "\""
	case "target-has-keyword":
		return negate + "the target has \"" + cstr(p["keyword"]) + "\""
	case "model-is-leader":
		return negate + "the model is leading a unit"
	case "is-attached":
		kw := ""
		if p["keyword"] != nil && truthy(p["keyword"]) {
			kw = cstr(p["keyword"]) + " "
		}
		return negate + "attached to a " + kw + "unit"
	case "attack-is-type":
		if p["comparison"] == "strength-greater-than-toughness" {
			return negate + "when this attack's Strength is greater than the target's Toughness"
		}
		if p["comparison"] != nil {
			return negate + "when " + dekebab(cstr(p["comparison"]))
		}
		return negate + "for " + cstr(p["attack_type"]) + " attacks"
	case "is-battle-shocked":
		return negate + "the unit is battle-shocked"
	case "has-lost-wounds":
		return negate + "the model has lost wounds"
	case "wounds-remaining-at-or-below":
		threshold := "0"
		if p["threshold"] != nil {
			threshold = cstr(p["threshold"])
		}
		return negate + "the model has " + threshold + " or fewer wounds remaining"
	case "was-hit-by-attack":
		subject := "the unit"
		if p["subject"] == "target" {
			subject = "the target"
		}
		atk := ""
		if p["attack_type"] != nil && truthy(p["attack_type"]) {
			atk = cstr(p["attack_type"]) + " "
		}
		weapon := ""
		if p["weapon_name"] != nil && truthy(p["weapon_name"]) {
			weapon = " by " + cstr(p["weapon_name"])
		}
		var n any = 1
		if p["count_min"] != nil {
			n = p["count_min"]
		}
		if isNumber(n) {
			if nf, _ := num(n); nf > 1 {
				return negate + subject + " was hit by " + cstr(n) + "+ " + atk + "attacks" + weapon + " this phase"
			}
		}
		article := "an attack"
		if atk != "" {
			article = "a " + atk + "attack"
		}
		return negate + subject + " was hit by " + article + weapon + " this phase"
	case "opponent-unit-within-range":
		var within string
		switch {
		case p["weapon_name"] != nil:
			within = "range of " + dekebab(cstr(p["weapon_name"]))
		case p["range_multiplier"] != nil:
			within = "half range of its ranged weapons"
		case p["range"] == "engagement":
			within = "engagement range"
		default:
			within = cstr(p["range"]) + "\""
		}
		return negate + "an enemy unit is within " + within
	case "unit-within-range-of":
		tt := "target"
		if p["target_type"] != nil {
			tt = cstr(p["target_type"])
		}
		if tt == "closest-eligible" {
			return negate + "the target is the closest eligible target"
		}
		if tt == "area-terrain" {
			return negate + "within an area terrain feature"
		}
		var who string
		if tt == "friendly-keyword" && p["keyword"] != nil && truthy(p["keyword"]) {
			who = "a friendly " + cstr(p["keyword"]) + " unit"
		} else if tt == "friendly" {
			who = "a friendly unit"
		} else {
			who = dekebab(tt)
		}
		dist := "?\""
		if p["range"] != nil {
			dist = cstr(p["range"]) + "\""
		}
		return negate + "within " + dist + " of " + who
	case "within-range-of-objective":
		return negate + "within range of an objective"
	case "has-fought-this-phase":
		return negate + "has fought this phase"
	case "destroyed-by-attack-type":
		return negate + "destroyed by a " + cstr(p["attack_type"]) + " attack"
	case "attack-stat-compare":
		// Mirrors the TS/Rust arms byte-for-byte: missing params render as "" (not "?").
		sv := func(v any) string {
			if v == nil {
				return ""
			}
			return cstr(v)
		}
		return negate + "the attack's " + sv(p["attacker_stat"]) + " is " + dekebab(sv(p["comparison"])) + " the target's " + sv(p["target_stat"])
	case "made-ingress-move-this-turn":
		return negate + "the unit made an ingress move this turn"

	// Scoring conditions.
	case "objective-majority":
		rel := "opponent"
		if p["relative_to"] != nil {
			rel = cstr(p["relative_to"])
		}
		return negate + "you hold more objectives than the " + dekebab(rel)
	case "controls-objective":
		noun := "objective"
		if p["objective_role"] != nil && truthy(p["objective_role"]) {
			noun = dekebab(cstr(p["objective_role"])) + " objective"
		}
		s := negate + "you control " + countNoun(countMinOr1(p), noun)
		if p["objective"] != nil {
			s += " (" + dekebab(cstr(p["objective"])) + ")"
		}
		if p["scope"] != nil {
			s += " in " + dekebab(cstr(p["scope"]))
		}
		if p["exclude"] != nil {
			s += " (excluding " + dekebab(cstr(p["exclude"])) + ")"
		}
		return s
	case "units-destroyed":
		s := negate + countNoun(countMinOr1(p), cstr(p["side"])+" unit") + " destroyed"
		if p["window"] != nil {
			s += " " + dekebab(cstr(p["window"]))
		}
		return s
	case "units-destroyed-comparison":
		subj, _ := getMap(p, "subject")
		ref, _ := getMap(p, "reference")
		gte := p["comparator"] == "greater-or-equal"
		cmp := "more"
		link := "than"
		if gte {
			cmp = "at least as many"
			link = "as"
		}
		return negate + "you destroyed " + cmp + " " + cstr(subj["side"]) + " units " +
			dekebab(cstr(subj["window"])) + " " + link + " " + cstr(ref["side"]) + " units " +
			dekebab(cstr(ref["window"]))
	case "new-objective-controlled":
		return negate + "you newly control " + countNoun(countMinOr1(p), "objective") + " this turn"
	case "destroyed-while-on-objective":
		obj := "an objective"
		if p["objective_role"] != nil && truthy(p["objective_role"]) {
			obj = "a " + dekebab(cstr(p["objective_role"])) + " objective"
		}
		s := negate + countNoun(countMinOr1(p), "enemy unit") + " destroyed"
		if truthy(p["destroyer_on_objective"]) {
			s += " by a unit on " + obj
		}
		if truthy(p["victim_on_objective"]) {
			s += " while on " + obj
		}
		if truthy(p["victim_started_turn_on_objective"]) {
			s += " that started the turn on " + obj
		}
		return s
	case "destroyed-in-tagged-terrain":
		where := "while in"
		if truthy(p["at_start_of_turn"]) {
			where = "that started the turn in"
		}
		terrain := "a terrain area"
		if p["tag"] != nil {
			terrain = dekebab(cstr(p["tag"])) + " terrain"
		}
		return negate + countNoun(countMinOr1(p), "enemy unit") + " destroyed " + where + " " + terrain
	case "operation-markers":
		side := ""
		if p["side"] != nil {
			side = cstr(p["side"]) + " "
		}
		var minP, maxP *float64
		if isNumber(p["count_min"]) {
			v, _ := num(p["count_min"])
			minP = &v
		}
		if isNumber(p["count_max"]) {
			v, _ := num(p["count_max"])
			maxP = &v
		}
		var s string
		switch {
		case maxP != nil && *maxP == 0:
			s = "no " + side + "operation markers on the battlefield"
		case minP != nil && maxP != nil && *minP == *maxP:
			plural := "s"
			if *minP == 1 {
				plural = ""
			}
			s = "exactly " + numStr(*minP) + " " + side + "operation marker" + plural + " on the battlefield"
		default:
			n := "1"
			if minP != nil {
				n = numStr(*minP)
			}
			s = n + "+ " + side + "operation markers on the battlefield"
		}
		if p["within_range_of"] != nil {
			s += " within range of " + dekebab(cstr(p["within_range_of"]))
		}
		if truthy(p["friendly_unit_in_same_terrain_area"]) {
			s += " with a friendly unit in the same terrain area"
		}
		if truthy(p["no_enemy_in_terrain_area"]) {
			s += " and no enemy units in that terrain area"
		}
		return negate + s
	case "action-completed":
		s := negate + countNoun(countMinOr1(p), "action") + " completed"
		if p["action_id"] != nil {
			s += " (" + dekebab(cstr(p["action_id"])) + ")"
		}
		if p["target_kind"] != nil {
			s += " on " + dekebab(cstr(p["target_kind"]))
		}
		tf, _ := getMap(p, "target_filter")
		if tf["objective_role"] != nil {
			s += " (" + dekebab(cstr(tf["objective_role"])) + ")"
		}
		if truthy(tf["in_enemy_territory"]) {
			s += " in enemy territory"
		}
		if tf["exclude"] != nil {
			s += " (excluding " + dekebab(cstr(tf["exclude"])) + ")"
		}
		if p["window"] != nil {
			s += " " + dekebab(cstr(p["window"]))
		}
		return s
	case "objective-has-tag":
		s := negate + countNoun(countMinOr1(p), "objective") + " tagged " + dekebab(cstr(p["tag"]))
		if p["count_max"] != nil {
			s += " (at most " + cstr(p["count_max"]) + ")"
		}
		if p["objective"] != nil {
			s += " (" + dekebab(cstr(p["objective"])) + ")"
		}
		if p["scope"] != nil {
			s += " in " + dekebab(cstr(p["scope"]))
		}
		if truthy(p["last_marked"]) {
			s += " (most recently marked)"
		}
		return s
	case "unit-has-tag":
		if p["side"] == nil && p["count_min"] == nil {
			return negate + "the unit is tagged " + dekebab(cstr(p["tag"]))
		}
		s := negate + countNoun(countMinOr1(p), cstr(p["side"])+" unit") + " tagged " + dekebab(cstr(p["tag"]))
		if p["window"] != nil {
			s += " (" + dekebab(cstr(p["window"])) + ")"
		}
		return s
	case "terrain-has-tag":
		s := negate + "terrain tagged " + dekebab(cstr(p["tag"]))
		if p["friendly_units_min"] != nil {
			s += " with " + cstr(p["friendly_units_min"]) + "+ friendly units"
		}
		if p["enemy_units_max"] != nil {
			s += " and at most " + cstr(p["enemy_units_max"]) + " enemy units"
		}
		if truthy(p["last_marked"]) {
			s += " (most recently marked)"
		}
		if truthy(p["in_enemy_dz"]) {
			s += " in the enemy deployment zone"
		}
		return s
	case "terrain-area-control":
		n := "1"
		if p["min_models"] != nil {
			n = cstr(p["min_models"])
		}
		return negate + "you control a terrain area with " + n + "+ models"
	case "territory-control":
		ref := "your-territory"
		if p["territory_ref"] != nil {
			ref = cstr(p["territory_ref"])
		}
		s := negate + "you control " + dekebab(ref)
		if p["enemy_units_max"] != nil {
			s += " with at most " + cstr(p["enemy_units_max"]) + " enemy units"
		}
		return s
	case "engagement-fronts":
		n := "1"
		if p["count_min"] != nil {
			n = cstr(p["count_min"])
		}
		return negate + "you are engaged on " + n + "+ fronts"
	}
	t := "unknown"
	if ctype != "" {
		t = ctype
	}
	return negate + dekebab(t)
}

func joinConds(operands []any, sep string) string {
	parts := make([]string, 0, len(operands))
	for _, o := range operands {
		om, _ := asMap(o)
		parts = append(parts, describeCondition(om))
	}
	return strings.Join(parts, sep)
}

func countMinOr1(p map[string]any) any {
	if p["count_min"] != nil {
		return p["count_min"]
	}
	return float64(1)
}
