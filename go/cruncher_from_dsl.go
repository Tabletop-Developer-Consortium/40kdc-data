package wh40kdc

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Translate an Ability DSL effect tree into the Buff stack it contributes,
// plus the fragments it could not auto-apply (unsupported) and player-decision
// levers (activatable). Go mirror of python .../cruncher/from_dsl.py. Applied
// order and unsupported-reason strings are pinned by
// conformance/abilities-resolver/from-dsl.json / defensive-from-dsl.json.

var selfTargets = map[string]bool{
	"self": true, "bearer": true, "unit": true, "attached-unit": true,
	"friendly-within-aura": true, "all-friendly": true,
}
var defenderTargets = map[string]bool{
	"defender": true, "enemy-within-aura": true, "all-enemy": true,
}

type effectTranslation struct {
	applied     []any
	unsupported []any
	activatable []any
}

type dslOpts struct {
	context     map[string]any
	perspective string
	abilityID   string
}

// effectToBuffs walks an ability DSL effect tree, producing the buff stack plus
// unsupported and activatable lists.
func effectToBuffs(effect any, source map[string]any, context map[string]any, perspective string) *effectTranslation {
	out := &effectTranslation{applied: []any{}, unsupported: []any{}, activatable: []any{}}
	abilityID := "effect"
	if getStr(source, "kind") == "ability" {
		if a := getStr(source, "abilityId"); a != "" {
			abilityID = a
		}
	}
	opts := dslOpts{context: context, perspective: perspective, abilityID: abilityID}
	dslWalk(effect, source, opts, out)
	return out
}

func dslWalk(node any, source map[string]any, opts dslOpts, out *effectTranslation) {
	n, ok := asMap(node)
	if !ok {
		return
	}
	switch getStr(n, "type") {
	case "re-roll":
		translateReroll(n, source, opts, out)
	case "roll-modifier":
		translateRollModifier(n, source, opts, out)
	case "stat-modifier":
		translateStatModifier(n, source, opts, out)
	case "feel-no-pain":
		translateFeelNoPain(n, source, opts, out)
	case "keyword-grant":
		translateKeywordGrant(n, source, opts, out)
	case "bs-modifier":
		translateBsModifier(n, source, opts, out)
	case "damage-reduction":
		translateDamageReduction(n, source, opts, out)
	case "invulnerable-save":
		translateInvulnerableSave(n, source, opts, out)
	case "conditional":
		translateConditional(n, source, opts, out)
	case "sequence":
		for _, step := range getList(n, "steps") {
			dslWalk(step, source, opts, out)
		}
	case "choice":
		enumerateChoice(n, source, opts, out)
	case "dice-gated":
		out.unsupported = append(out.unsupported, unsup("dice-gated effect: stochastic; not expressible as a buff", n))
	case "dice-pool-allocation":
		enumerateDicePool(n, source, opts, out)
	case "select-units":
		// Targeting wrapper — the selected units receive the nested effect.
		dslWalk(n["effect"], source, opts, out)
	default:
		out.unsupported = append(out.unsupported, unsup("effect type \""+jsStr(n["type"])+"\" is not modelled by the buff layer", n))
	}
}

func unsup(reason string, fragment any) map[string]any {
	return map[string]any{"reason": reason, "effectFragment": fragment}
}

func classifyTarget(node map[string]any) string {
	target, ok := node["target"].(string)
	if !ok {
		return "unknown"
	}
	if target == "attacker" {
		return "attacker"
	}
	if defenderTargets[target] {
		return "defender"
	}
	if selfTargets[target] {
		return "self"
	}
	return "unknown"
}

func appliesToBuffedUnit(node map[string]any, perspective string) bool {
	switch classifyTarget(node) {
	case "self":
		return true
	case "attacker":
		return perspective == "attacker"
	case "defender":
		return perspective == "target"
	}
	return false
}

func translateReroll(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	if opts.perspective == "attacker" && !appliesToBuffedUnit(node, "attacker") {
		return
	}
	modifier, ok := getMap(node, "modifier")
	if !ok {
		out.unsupported = append(out.unsupported, unsup("re-roll: missing modifier object", node))
		return
	}
	if narrowed := unhonorableNarrowing(modifier); narrowed != "" {
		out.unsupported = append(out.unsupported, unsup("re-roll: narrows by \""+narrowed+"\" which the cruncher can't resolve here", node))
		return
	}
	roll, _ := modifier["roll"].(string)
	subset, _ := modifier["subset"].(string)
	if jsNumberEq(modifier["value"], 1) {
		subset = "ones"
	}
	if opts.perspective == "target" && roll != "save" {
		return
	}
	if (roll == "hit" || roll == "wound" || roll == "save" || roll == "damage") &&
		(subset == "ones" || subset == "all-failures") {
		out.applied = append(out.applied, map[string]any{"source": source, "contribution": map[string]any{"type": "reroll", "roll": roll, "subset": subset}})
		return
	}
	out.unsupported = append(out.unsupported, unsup("re-roll on \""+jsStr(modifier["roll"])+"\" (subset \""+jsStr(modifier["subset"])+"\") is outside the damage path", node))
}

func translateRollModifier(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	modifier, ok := getMap(node, "modifier")
	if !ok {
		out.unsupported = append(out.unsupported, unsup("roll-modifier: missing modifier object", node))
		return
	}
	if narrowed := unhonorableNarrowing(modifier); narrowed != "" {
		out.unsupported = append(out.unsupported, unsup("roll-modifier: narrows by \""+narrowed+"\" which the cruncher can't resolve here", node))
		return
	}
	value, ok := signedValue(modifier)
	if !ok {
		out.unsupported = append(out.unsupported, unsup("roll-modifier: operation \""+jsStr(modifier["operation"])+"\" not supported", node))
		return
	}
	roll, _ := modifier["roll"].(string)
	if opts.perspective == "attacker" {
		if !appliesToBuffedUnit(node, "attacker") {
			return
		}
		if roll == "save" {
			return
		}
	} else {
		cls := classifyTarget(node)
		if cls == "attacker" {
			if roll != "hit" && roll != "wound" {
				return
			}
		} else if cls == "self" {
			if roll != "save" {
				return
			}
		} else {
			return
		}
	}
	ct := rollToContribType(roll)
	if ct == "" {
		out.unsupported = append(out.unsupported, unsup("roll-modifier on \""+jsStr(modifier["roll"])+"\" is outside the damage path", node))
		return
	}
	out.applied = append(out.applied, map[string]any{"source": source, "contribution": map[string]any{"type": ct, "value": value}})
}

func translateStatModifier(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	modifier, ok := getMap(node, "modifier")
	if !ok {
		out.unsupported = append(out.unsupported, unsup("stat-modifier: missing modifier object", node))
		return
	}
	if narrowed := unhonorableNarrowing(modifier); narrowed != "" {
		out.unsupported = append(out.unsupported, unsup("stat-modifier: narrows by \""+narrowed+"\" which the cruncher can't resolve here", node))
		return
	}
	stat, _ := modifier["stat"].(string)
	isOnBuffedUnit := appliesToBuffedUnit(node, opts.perspective)
	applicability := attackTypeApplicability(modifier)

	emit := func(contribution map[string]any) {
		buff := map[string]any{"source": source, "contribution": contribution}
		if applicability != nil {
			buff["applicableWhen"] = applicability
		}
		out.applied = append(out.applied, buff)
	}

	if stat == "AP" {
		translateAPModifier(node, modifier, opts, out, emit)
		return
	}

	value, ok := signedValue(modifier)
	if !ok {
		out.unsupported = append(out.unsupported, unsup("stat-modifier: operation \""+jsStr(modifier["operation"])+"\" not supported", node))
		return
	}
	switch stat {
	case "A":
		if opts.perspective != "attacker" || !isOnBuffedUnit {
			return
		}
		emit(map[string]any{"type": "attacks-mod", "value": value})
	case "S":
		if opts.perspective != "attacker" || !isOnBuffedUnit {
			return
		}
		emit(map[string]any{"type": "strength-mod", "value": value})
	case "T":
		if opts.perspective != "target" {
			out.unsupported = append(out.unsupported, unsup("stat-modifier T: defender-side stat; applies when the buffed unit is the target", node))
			return
		}
		if !isOnBuffedUnit {
			return
		}
		emit(map[string]any{"type": "toughness-mod", "value": value})
	case "Sv":
		if opts.perspective != "target" {
			out.unsupported = append(out.unsupported, unsup("stat-modifier Sv: defender-side stat; applies when the buffed unit is the target", node))
			return
		}
		if !isOnBuffedUnit {
			return
		}
		emit(map[string]any{"type": "save-mod", "value": -value})
	default:
		out.unsupported = append(out.unsupported, unsup("stat-modifier on \""+jsStr(modifier["stat"])+"\" is outside the damage path", node))
	}
}

func translateAPModifier(node, modifier map[string]any, opts dslOpts, out *effectTranslation, emit func(map[string]any)) {
	if classifyTarget(node) == "attacker" {
		out.unsupported = append(out.unsupported, unsup("stat-modifier AP on the attacker: defender-side AP reduction is not modelled by the buff layer", node))
		return
	}
	if opts.perspective != "attacker" || !appliesToBuffedUnit(node, "attacker") {
		return
	}
	delta, ok := apDelta(modifier)
	if !ok {
		out.unsupported = append(out.unsupported, unsup("stat-modifier AP: operation \""+jsStr(modifier["operation"])+"\" not supported", node))
		return
	}
	emit(map[string]any{"type": "ap-mod", "value": delta})
}

func translateFeelNoPain(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	if opts.perspective != "target" {
		return
	}
	modifier, ok := getMap(node, "modifier")
	if !ok {
		out.unsupported = append(out.unsupported, unsup("feel-no-pain: missing modifier object", node))
		return
	}
	threshold := jsNumber(modifier["threshold"])
	if math.IsInf(threshold, 0) || math.IsNaN(threshold) {
		out.unsupported = append(out.unsupported, unsup("feel-no-pain: threshold not numeric", node))
		return
	}
	rawScope := modifier["scope"]
	scope := "all"
	if rawScope != nil {
		if rawScope == "all" || rawScope == "mortal" {
			scope = rawScope.(string)
		} else {
			out.unsupported = append(out.unsupported, unsup("feel-no-pain: unrecognised scope \""+jsStr(rawScope)+"\" (expected \"all\" or \"mortal\")", node))
			return
		}
	}
	contribution := map[string]any{"type": "feel-no-pain", "threshold": threshold}
	if scope == "mortal" {
		contribution["scope"] = "mortal"
	}
	out.applied = append(out.applied, map[string]any{"source": source, "contribution": contribution})
}

func translateKeywordGrant(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	if opts.perspective != "attacker" {
		return
	}
	if !appliesToBuffedUnit(node, "attacker") {
		return
	}
	modifier, ok := getMap(node, "modifier")
	if !ok {
		return
	}
	raws := keywordGrantList(modifier)
	if len(raws) == 0 {
		return
	}
	applicability := weaponTypeApplicability(modifier)
	for _, raw := range raws {
		ref := parseKeywordGrant(raw)
		if ref == nil {
			out.unsupported = append(out.unsupported, unsup("keyword-grant: cannot parse \""+raw+"\" to a catalog keyword", map[string]any{"keyword": raw}))
			continue
		}
		buff := map[string]any{"source": source, "contribution": map[string]any{"type": "extra-keyword", "keywordRef": ref}}
		if applicability != nil {
			buff["applicableWhen"] = applicability
		}
		out.applied = append(out.applied, buff)
	}
}

func keywordGrantList(modifier map[string]any) []string {
	var out []string
	if k, ok := modifier["keyword"].(string); ok {
		out = append(out, k)
	}
	if arr, ok := asList(modifier["keywords"]); ok {
		for _, k := range arr {
			if s, ok := k.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func weaponTypeApplicability(modifier map[string]any) map[string]any {
	switch modifier["weapon_type"] {
	case "melee":
		return map[string]any{"phases": []any{"fight"}}
	case "ranged":
		return map[string]any{"phases": []any{"shooting"}}
	}
	return nil
}

func attackTypeApplicability(modifier map[string]any) map[string]any {
	kind := modifier["attack_type"]
	if kind == nil {
		kind = modifier["weapon_type"]
	}
	switch kind {
	case "melee":
		return map[string]any{"phases": []any{"fight"}}
	case "ranged":
		return map[string]any{"phases": []any{"shooting"}}
	}
	return nil
}

var unhonorableNarrowingKeys = []string{
	"weapon_name", "weapon_profile", "weapon_keyword", "weapon_filter",
	"model_filter", "model_scope",
}

func unhonorableNarrowing(modifier map[string]any) string {
	for _, k := range unhonorableNarrowingKeys {
		if modifier[k] != nil {
			return k
		}
	}
	return ""
}

func translateDamageReduction(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	if opts.perspective != "target" {
		return
	}
	if !appliesToBuffedUnit(node, "target") {
		return
	}
	modifier, ok := getMap(node, "modifier")
	if !ok {
		out.unsupported = append(out.unsupported, unsup("damage-reduction: missing modifier object", node))
		return
	}
	reduction := modifier["reduction"]
	if isNumber(reduction) {
		r, _ := num(reduction)
		if !math.IsInf(r, 0) && !math.IsNaN(r) && r > 0 {
			out.applied = append(out.applied, map[string]any{"source": source, "contribution": map[string]any{"type": "damage-reduction", "value": r}})
			return
		}
	}
	if reduction == "half" || reduction == "to-zero" {
		out.unsupported = append(out.unsupported, unsup("damage-reduction: \""+reduction.(string)+"\" is a one-use ablation effect, not modelled by the expected-value engine", node))
		return
	}
	out.unsupported = append(out.unsupported, unsup("damage-reduction: unrecognised reduction \""+jsStr(reduction)+"\"", node))
}

func translateInvulnerableSave(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	if opts.perspective != "target" {
		return
	}
	if !appliesToBuffedUnit(node, "target") {
		return
	}
	modifier, ok := getMap(node, "modifier")
	if !ok {
		out.unsupported = append(out.unsupported, unsup("invulnerable-save: missing modifier object", node))
		return
	}
	threshold := jsNumber(modifier["invuln_sv"])
	if math.IsInf(threshold, 0) || math.IsNaN(threshold) || threshold < 2 || threshold > 7 {
		out.unsupported = append(out.unsupported, unsup("invulnerable-save: invuln_sv \""+jsStr(modifier["invuln_sv"])+"\" is not a valid save threshold (2-7)", node))
		return
	}
	out.applied = append(out.applied, map[string]any{"source": source, "contribution": map[string]any{"type": "invulnerable-save", "threshold": threshold}})
}

func translateBsModifier(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	if opts.perspective != "target" {
		return
	}
	if classifyTarget(node) != "attacker" {
		return
	}
	modifier, ok := getMap(node, "modifier")
	if !ok {
		return
	}
	value, ok := signedValue(modifier)
	if !ok {
		return
	}
	out.applied = append(out.applied, map[string]any{"source": source, "contribution": map[string]any{"type": "hit-mod", "value": value}})
}

func translateConditional(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	condition, ok := getMap(node, "condition")
	if !ok {
		return
	}
	negated := condition["negated"] == true
	verdict := evaluateCondition(condition, opts.context)
	if verdict == nil { // unknown
		if conditionMentionsTiming(condition) {
			enumerateTimingGate(node, source, opts, out)
		} else {
			out.unsupported = append(out.unsupported, unsup("conditional: cannot evaluate condition \""+jsStr(condition["type"])+"\" against current context", node))
		}
		return
	}
	v := verdict.(bool)
	active := v
	if negated {
		active = !v
	}
	if !active {
		return
	}
	dslWalk(node["effect"], source, opts, out)
}

// --- activatable-lever enumeration ---

func enumerateChoice(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	options, _ := asList(node["options"])
	for i, opt := range options {
		var buffs []any
		collectGatedBuffs(opt, source, opts, map[string]any{}, &buffs)
		if len(buffs) == 0 {
			continue
		}
		out.activatable = append(out.activatable, map[string]any{
			"id":    opts.abilityID + "?" + strconv.Itoa(i),
			"label": labelForBuffs(buffs),
			"buffs": buffs,
			"group": map[string]any{"id": opts.abilityID + "?choice", "maxActivations": float64(1)},
		})
	}
}

func enumerateDicePool(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	options, _ := asList(node["options"])
	var maxActivations float64
	if isNumber(node["max_activations"]) {
		maxActivations, _ = num(node["max_activations"])
	} else {
		maxActivations = float64(len(options))
	}
	for _, optAny := range options {
		opt, ok := asMap(optAny)
		if !ok {
			continue
		}
		var buffs []any
		collectGatedBuffs(opt["effect"], source, opts, map[string]any{}, &buffs)
		if len(buffs) == 0 {
			continue
		}
		name, _ := opt["name"].(string)
		if name == "" {
			name = labelForBuffs(buffs)
		}
		out.activatable = append(out.activatable, map[string]any{
			"id":    opts.abilityID + "#" + name,
			"label": name,
			"buffs": buffs,
			"group": map[string]any{"id": opts.abilityID, "maxActivations": maxActivations},
		})
	}
}

func enumerateTimingGate(node, source map[string]any, opts dslOpts, out *effectTranslation) {
	condition, ok := getMap(node, "condition")
	if !ok {
		return
	}
	sub := &effectTranslation{applied: []any{}, unsupported: []any{}, activatable: []any{}}
	dslWalk(node["effect"], source, opts, sub)
	out.activatable = append(out.activatable, sub.activatable...)
	if len(sub.applied) > 0 {
		timing := extractTiming(condition)
		if timing == "" {
			timing = "timing"
		}
		out.activatable = append(out.activatable, map[string]any{
			"id":    opts.abilityID + "@" + timing,
			"label": labelForBuffs(sub.applied),
			"buffs": sub.applied,
		})
	}
}

func collectGatedBuffs(node any, source map[string]any, opts dslOpts, applicability map[string]any, outBuffs *[]any) {
	n, ok := asMap(node)
	if !ok {
		return
	}
	switch getStr(n, "type") {
	case "conditional":
		condition, ok := getMap(n, "condition")
		if !ok {
			return
		}
		app := conditionToApplicability(condition)
		switch a := app.(type) {
		case string:
			if a == "gate" {
				collectGatedBuffs(n["effect"], source, opts, applicability, outBuffs)
				return
			}
			if a == "context" {
				if evaluateCondition(condition, opts.context) == true {
					collectGatedBuffs(n["effect"], source, opts, applicability, outBuffs)
				}
				return
			}
		case map[string]any:
			collectGatedBuffs(n["effect"], source, opts, combineApplicability(applicability, a), outBuffs)
			return
		}
		return
	case "sequence":
		for _, step := range getList(n, "steps") {
			collectGatedBuffs(step, source, opts, applicability, outBuffs)
		}
		return
	case "choice", "dice-pool-allocation", "dice-gated":
		return
	}
	tmp := &effectTranslation{applied: []any{}, unsupported: []any{}, activatable: []any{}}
	dslWalk(n, source, opts, tmp)
	for _, b := range tmp.applied {
		*outBuffs = append(*outBuffs, applyApplicability(b.(map[string]any), applicability))
	}
}

func conditionMentionsTiming(condition map[string]any) bool {
	if getStr(condition, "type") == "timing-is" {
		return true
	}
	if _, ok := condition["operator"].(string); ok {
		if operands, ok := asList(condition["operands"]); ok {
			for _, o := range operands {
				if om, ok := asMap(o); ok && conditionMentionsTiming(om) {
					return true
				}
			}
		}
	}
	return false
}

func extractTiming(condition map[string]any) string {
	if getStr(condition, "type") == "timing-is" {
		params, _ := getMap(condition, "parameters")
		if t, ok := params["timing"].(string); ok {
			return t
		}
		return ""
	}
	if operands, ok := asList(condition["operands"]); ok {
		for _, o := range operands {
			if om, ok := asMap(o); ok {
				if t := extractTiming(om); t != "" {
					return t
				}
			}
		}
	}
	return ""
}

// conditionToApplicability returns "gate", "context", or a map[string]any.
func conditionToApplicability(condition map[string]any) any {
	if condition["negated"] == true {
		return "context"
	}
	if op, ok := condition["operator"].(string); ok {
		if operands, ok := asList(condition["operands"]); ok {
			if op != "and" {
				return "context"
			}
			merged := map[string]any{}
			for _, operandAny := range operands {
				operand, ok := asMap(operandAny)
				if !ok {
					return "context"
				}
				a := conditionToApplicability(operand)
				if a == "gate" {
					continue
				}
				if a == "context" {
					return "context"
				}
				merged = combineApplicability(merged, a.(map[string]any))
			}
			return merged
		}
	}
	params, _ := getMap(condition, "parameters")
	switch getStr(condition, "type") {
	case "timing-is":
		return "gate"
	case "phase-is":
		if phase, ok := params["phase"].(string); ok {
			return map[string]any{"phases": []any{phase}}
		}
		return "context"
	case "target-has-keyword":
		if kw, ok := params["keyword"].(string); ok {
			return map[string]any{"requiresTargetKeyword": kw}
		}
		return "context"
	case "unit-has-keyword":
		if kw, ok := params["keyword"].(string); ok {
			return map[string]any{"requiresAttackerKeyword": kw}
		}
		return "context"
	case "attack-is-type":
		switch params["attack_type"] {
		case "melee":
			return map[string]any{"phases": []any{"fight"}}
		case "ranged":
			return map[string]any{"phases": []any{"shooting"}}
		}
		return "context"
	}
	return "context"
}

func combineApplicability(a, b map[string]any) map[string]any {
	out := cloneMap(a)
	if bp := getList(b, "phases"); len(bp) > 0 {
		if ap := getList(a, "phases"); len(ap) > 0 {
			var inter []any
			for _, p := range ap {
				if containsAnyV(bp, p) {
					inter = append(inter, p)
				}
			}
			if inter == nil {
				inter = []any{}
			}
			out["phases"] = inter
		} else {
			out["phases"] = bp
		}
	}
	if v, ok := b["rollType"]; ok && v != nil {
		out["rollType"] = v
	}
	if v, ok := b["requiresTargetKeyword"]; ok && v != nil {
		out["requiresTargetKeyword"] = v
	}
	if v, ok := b["requiresAttackerKeyword"]; ok && v != nil {
		out["requiresAttackerKeyword"] = v
	}
	return out
}

func applyApplicability(buff map[string]any, applicability map[string]any) map[string]any {
	if len(applicability) == 0 {
		return buff
	}
	merged := applicability
	if existing, ok := getMap(buff, "applicableWhen"); ok {
		merged = combineApplicability(existing, applicability)
	}
	out := cloneMap(buff)
	out["applicableWhen"] = merged
	return out
}

func labelForBuffs(buffs []any) string {
	seen := map[string]bool{}
	var parts []string
	for _, bAny := range buffs {
		b, _ := asMap(bAny)
		c, _ := getMap(b, "contribution")
		p := describeContribution(c)
		if !seen[p] {
			seen[p] = true
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return "buff"
	}
	return strings.Join(parts, ", ")
}

func describeContribution(c map[string]any) string {
	switch getStr(c, "type") {
	case "extra-keyword":
		ref, _ := getMap(c, "keywordRef")
		return keywordLabel(ref)
	case "hit-mod":
		return signedStr(c["value"]) + " to hit"
	case "wound-mod":
		return signedStr(c["value"]) + " to wound"
	case "save-mod":
		return signedStr(c["value"]) + " to save"
	case "damage-mod":
		return signedStr(c["value"]) + " damage"
	case "attacks-mod":
		return signedStr(c["value"]) + " attacks"
	case "strength-mod":
		return signedStr(c["value"]) + " strength"
	case "toughness-mod":
		return signedStr(c["value"]) + " toughness"
	case "ap-mod":
		return "AP " + numStr(c["value"])
	case "reroll":
		ones := ""
		if getStr(c, "subset") == "ones" {
			ones = " 1s"
		}
		return "re-roll " + getStr(c, "roll") + ones
	case "feel-no-pain":
		if getStr(c, "scope") == "mortal" {
			return "feel no pain " + numStr(c["threshold"]) + "+ vs mortals"
		}
		return "feel no pain " + numStr(c["threshold"]) + "+"
	case "damage-reduction":
		return "-" + numStr(c["value"]) + " damage"
	case "invulnerable-save":
		return numStr(c["threshold"]) + "+ invuln"
	}
	return "cover"
}

func signedStr(v any) string {
	n, _ := num(v)
	if n >= 0 {
		return "+" + numStr(v)
	}
	return numStr(v)
}

func keywordLabel(ref map[string]any) string {
	params, _ := getMap(ref, "parameters")
	if getStr(ref, "keyword_id") == "anti" {
		if tk, ok := params["target_keyword"].(string); ok {
			suffix := ""
			if isNumber(params["threshold"]) {
				suffix = " " + numStr(params["threshold"]) + "+"
			}
			return "Anti-" + tk + suffix
		}
	}
	var words []string
	for _, w := range strings.Split(getStr(ref, "keyword_id"), "-") {
		if w == "" {
			words = append(words, w)
		} else {
			words = append(words, strings.ToUpper(w[:1])+w[1:])
		}
	}
	base := strings.Join(words, " ")
	if isNumber(params["value"]) {
		return base + " " + numStr(params["value"])
	}
	return base
}

// --- condition evaluator ---

// evaluateCondition returns bool, or nil for "unknown".
func evaluateCondition(condition, ctx map[string]any) any {
	if op, ok := condition["operator"].(string); ok {
		if operands, ok := asList(condition["operands"]); ok {
			return evaluateCompound(op, operands, ctx)
		}
	}
	params, _ := getMap(condition, "parameters")
	switch getStr(condition, "type") {
	case "phase-is":
		wanted, ok := params["phase"].(string)
		if !ok {
			return nil
		}
		return ctx["phase"] == wanted
	case "timing-is":
		wanted, ok := params["timing"].(string)
		if !ok {
			return nil
		}
		if ctx["timing"] == nil {
			return nil
		}
		return ctx["timing"] == wanted
	case "remained-stationary":
		return ctx["attackerStationary"] == true
	case "charged-this-turn":
		if ctx["attackerCharged"] == nil {
			return nil
		}
		return ctx["attackerCharged"] == true
	case "target-has-keyword":
		kw, ok := params["keyword"].(string)
		if !ok {
			return nil
		}
		return containsAny(getList(ctx, "targetKeywords"), lower(kw))
	case "unit-has-keyword":
		kw, ok := params["keyword"].(string)
		if !ok {
			return nil
		}
		return containsAny(getList(ctx, "attackerKeywords"), lower(kw))
	case "is-attached", "model-is-leader":
		if ctx["attackerAttached"] == nil {
			return nil
		}
		return ctx["attackerAttached"] == true
	}
	return nil
}

func evaluateCompound(operator string, operands []any, ctx map[string]any) any {
	if operator == "not" {
		if len(operands) == 0 {
			return nil
		}
		first, ok := asMap(operands[0])
		if !ok {
			return nil
		}
		v := evaluateCondition(first, ctx)
		if v == nil {
			return nil
		}
		return !v.(bool)
	}
	if operator != "and" && operator != "or" {
		return nil
	}
	sawUnknown := false
	for _, operandAny := range operands {
		operand, ok := asMap(operandAny)
		if !ok {
			sawUnknown = true
			continue
		}
		v := evaluateCondition(operand, ctx)
		if v == nil {
			sawUnknown = true
			continue
		}
		if operator == "and" && v == false {
			return false
		}
		if operator == "or" && v == true {
			return true
		}
	}
	if sawUnknown {
		return nil
	}
	return operator == "and"
}

// --- helpers ---

func jsStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "undefined"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return numStr(x)
	case string:
		return x
	}
	return numStr(v)
}

func jsNumberEq(v any, target float64) bool {
	n := jsNumber(v)
	return !math.IsNaN(n) && n == target
}

func signedValue(modifier map[string]any) (float64, bool) {
	value := jsNumber(modifier["value"])
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return 0, false
	}
	switch modifier["operation"] {
	case "add", "improve":
		return value, true
	case "subtract", "worsen":
		return -value, true
	}
	return 0, false
}

func apDelta(modifier map[string]any) (float64, bool) {
	value := jsNumber(modifier["value"])
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return 0, false
	}
	switch modifier["operation"] {
	case "improve":
		return -math.Abs(value), true
	case "worsen":
		return math.Abs(value), true
	case "add":
		return value, true
	case "subtract":
		return -value, true
	}
	return 0, false
}

var antiGrantRe = regexp.MustCompile(`(?i)^anti-([A-Za-z][A-Za-z\s-]*)\s+(\d+)\+?$`)
var valueGrantRe = regexp.MustCompile(`^(.+?)\s+(\d+)$`)

func parseKeywordGrant(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	if m := antiGrantRe.FindStringSubmatch(trimmed); m != nil {
		th, _ := strconv.Atoi(m[2])
		return map[string]any{"keyword_id": "anti", "parameters": map[string]any{
			"target_keyword": strings.TrimSpace(m[1]),
			"threshold":      float64(th),
		}}
	}
	if m := valueGrantRe.FindStringSubmatch(trimmed); m != nil {
		val, _ := strconv.Atoi(m[2])
		return map[string]any{"keyword_id": toKebabCase(m[1]), "parameters": map[string]any{"value": float64(val)}}
	}
	return map[string]any{"keyword_id": toKebabCase(trimmed)}
}

var kebabSpaceRe = regexp.MustCompile(`[\s_]+`)
var kebabStripRe = regexp.MustCompile(`[^a-z0-9-]`)

func toKebabCase(s string) string {
	return kebabStripRe.ReplaceAllString(kebabSpaceRe.ReplaceAllString(strings.ToLower(s), "-"), "")
}

func containsAnyV(l []any, v any) bool {
	for _, x := range l {
		if x == v {
			return true
		}
	}
	return false
}
