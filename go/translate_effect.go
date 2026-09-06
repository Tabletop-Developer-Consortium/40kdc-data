package wh40kdc

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Humanize an Ability-DSL effect tree into natural English. ASCII-only, pinned
// byte-for-byte by conformance/effect-translation. Go mirror of
// python .../translate/effect.py.

var containerTypes = map[string]bool{
	"rules-bundle": true, "sequence": true, "named-effect": true, "choice": true, "dice-gated": true, "dice-table": true, "dice-pool-allocation": true, "select-units": true,
	"for-each-unit": true, "designate-target": true, "persistent-designation": true, "stance-select": true, "risk-reward": true,
	"issue-orders": true, "resource-action-menu": true,
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
	exactCount := sel["count"]
	if exactCount == nil && sel["min_count"] != nil && asFloat(sel["min_count"]) == asFloat(sel["max_count"]) {
		exactCount = sel["max_count"]
	}
	bounded := sel["min_count"] != nil && exactCount == nil
	count := sel["max_count"]
	if exactCount != nil {
		count = exactCount
	}
	single := asFloat(count) == 1
	noun := "unit"
	if sel["target_kind"] == "model" {
		noun = "model"
	}
	if !single {
		noun += "s"
	}
	quantity := "up to " + ejstr(count)
	if exactCount != nil {
		quantity = ejstr(count)
		if single {
			quantity = "one"
		}
	} else if bounded {
		quantity = "from " + ejstr(sel["min_count"]) + " through " + ejstr(sel["max_count"])
	}
	within := ""
	if sel["within_inches"] != nil {
		within = " within " + ejstr(sel["within_inches"]) + "\""
	} else if sel["range_inches"] != nil {
		origin := "the bearer"
		if sel["reference"] == "bearer-unit" {
			origin = "this model's unit"
		}
		within = " within " + ejstr(sel["range_inches"]) + " inches of " + origin
	}
	visible := ""
	if sel["visibility_required"] == true {
		visible = " visible to the bearer"
	}
	inclusive := ""
	if bounded {
		inclusive = ", inclusive"
	}
	return quantity + " " + ejstr(sel["owner"]) + kw + " " + noun + inclusive + within + visible + selectorEligibilityClause(sel)
}

func selectUnitsEngagement(sel map[string]any) string {
	parts := []string{}
	noun, origin := "unit", "the bearer"
	if sel["target_kind"] == "model" {
		noun = "model"
	}
	if sel["reference"] == "bearer-unit" {
		origin = "this model's unit"
	}
	if sel["engagement_relation"] == "engaged-with-bearer" {
		parts = append(parts, "For each selected "+noun+", it must be within Engagement Range of "+origin+".")
	}
	if sel["engagement_relation"] == "not-engaged-with-bearer" {
		parts = append(parts, "For each selected "+noun+", it must not be within Engagement Range of "+origin+".")
	}
	if limit, ok := getMap(sel, "selection_limit"); ok && limit != nil {
		parts = append(parts, "Each "+noun+" can be selected for this ability at most "+selectionFrequency(limit["count"])+" per "+dekebab(ejstr(limit["period"]))+" across your army.")
	}
	return strings.Join(parts, " ")
}

func selectUnitsPlural(sel map[string]any) bool {
	count := sel["count"]
	if count == nil {
		count = sel["max_count"]
	}
	return asFloat(count) > 1
}

func selectedRecipient(text string, sel map[string]any) string {
	noun := "unit"
	if sel["target_kind"] == "model" {
		noun = "model"
	}
	recipient := "the selected " + noun
	if selectUnitsPlural(sel) {
		recipient = "each selected " + noun
	}
	text = strings.ReplaceAll(text, "The unit's", "Each selected "+noun+"'s")
	text = strings.ReplaceAll(text, "the unit's", recipient+"'s")
	text = strings.ReplaceAll(text, "The unit", "Each selected "+noun)
	return strings.ReplaceAll(text, "the unit", recipient)
}

func selectUnitsInline(sel map[string]any, inner map[string]any, ctx map[string]any) string {
	nested := selectedRecipient(describeEffectInline(inner, ctx), sel)
	engagement := selectUnitsEngagement(sel)
	if engagement != "" {
		return "select " + selectUnitsSubject(sel) + ". " + engagement + " " + capitalize(nested)
	}
	return "select " + selectUnitsSubject(sel) + ": " + nested
}

// selectorEligibilityClause renders a select-units candidate predicate before
// the selected effect, because it restricts which units can be selected.
func selectorEligibilityClause(sel map[string]any) string {
	eligibility, ok := getMap(sel, "eligibility")
	if !ok || eligibility == nil {
		return ""
	}
	return " " + describeSelectionEligibility(eligibility)
}

// forEachUnitSubject renders the closed for-each-unit selector.
func forEachUnitSubject(sel map[string]any) string {
	var keywords []string
	for _, keyword := range getStrList(sel, "keywords") {
		keywords = append(keywords, titleCase(keyword))
	}
	within := ""
	if sel["within_inches"] != nil {
		within = " within " + ejstr(sel["within_inches"]) + "\""
	}
	keywordText := ""
	if len(keywords) > 0 {
		keywordText = " " + strings.Join(keywords, " ")
	}
	noun := "unit"
	if sel["target_kind"] == "model" {
		noun = "model"
	}
	member := ""
	if sel["member_of"] == "bearer-unit" {
		member = " in this model's unit"
	}
	return ejstr(sel["owner"]) + keywordText + " " + noun + member + within
}

// forEachUnitCtx binds each iteration's matching unit or model as its target.
func forEachUnitCtx(ctx map[string]any, sel map[string]any) map[string]any {
	nc := selectUnitsCtx(ctx, sel)
	nc["selected_target"] = true
	return nc
}

// selectUnitsCtx marks nested unit targets as the selected unit or model
// regardless of whether the selector uses an exact count or an up-to maximum.
func selectUnitsCtx(ctx map[string]any, sel map[string]any) map[string]any {
	nc := make(map[string]any, len(ctx)+1)
	for k, v := range ctx {
		nc[k] = v
	}
	nc["selected_model"] = sel["target_kind"] == "model"
	nc["selected_unit"] = sel["target_kind"] != "model"
	return nc
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
	"nurgle-s-gift-aura":     "Nurgle's Gift (Aura)",
}

// grantLabel returns the curated label for a granted ability id, else Title Case.
func grantLabel(id string) string {
	if label, ok := abilityGrantLabels[id]; ok {
		return label
	}
	return titleCase(id)
}

// designationLabel renders "(your Suppressed target)" — a designate-target
// mark's parenthetical. A designation slug that already ends in "target" keeps
// its own noun ("bio-stimulus-target" → "(your Bio Stimulus Target)", not
// "… Target target").
func designationLabel(designation any) string {
	label := titleCase(ejstr(designation))
	if label == "Target" || strings.HasSuffix(label, " Target") {
		return " (your " + label + ")"
	}
	return " (your " + label + " target)"
}

func designationTargetSubjectBase(sel map[string]any) string {
	disposition := "enemy"
	if sel["scope"] == "friendly-unit" {
		disposition = "friendly"
	}
	keywords := make([]string, 0, len(getList(sel, "keywords")))
	for _, keyword := range getList(sel, "keywords") {
		keywords = append(keywords, titleCase(ejstr(keyword)))
	}
	keywordJoin := " "
	if sel["keyword_match"] == "any" {
		keywordJoin = " or "
	}
	keywordText := ""
	if len(keywords) > 0 {
		keywordText = " " + strings.Join(keywords, keywordJoin)
	}
	within := ""
	if sel["within_inches"] != nil {
		within = " within " + ejstr(sel["within_inches"]) + " inches"
	}
	return disposition + keywordText + " unit" + within
}

func transportCapacityConversion(m map[string]any) string {
	keyword := ""
	if m["model_keyword"] != nil {
		keyword = titleCase(ejstr(m["model_keyword"]))
	}
	singleModel := m["subject_kind"] == "single-model"
	model := "model in this unit"
	if keyword != "" {
		if singleModel {
			model = "this " + keyword + " model"
		} else {
			model = keyword + " model"
		}
	} else if singleModel {
		model = "this model"
	}
	eachModel := "each " + model
	if singleModel {
		eachModel = model
	}
	eligibility, _ := asMap(m["transport_eligibility"])
	qualification := ""
	if eligibility["requires_capacity_keyword"] != nil {
		qualification = " in a Transport able to carry " + titleCase(ejstr(eligibility["requires_capacity_keyword"])) + " models"
	} else if eligibility["embark_as_keyword"] != nil {
		qualification = " when embarking as " + titleCase(ejstr(eligibility["embark_as_keyword"]))
	}

	if m["occupancy_kind"] == "fixed-model-spaces" {
		spaces := asFloat(m["spaces_per_model"])
		suffix := "s"
		if spaces == 1 {
			suffix = ""
		}
		return "for Transport capacity" + qualification + ", " + eachModel + " occupies " + ejstr(m["spaces_per_model"]) + " model space" + suffix
	}
	if m["occupancy_kind"] == "equivalent-model" {
		equivalent := "model"
		if m["equivalent_model_keyword"] != nil {
			equivalent = titleCase(ejstr(m["equivalent_model_keyword"])) + " model"
		}
		count := m["equivalent_model_count"]
		if count == nil {
			count = float64(1)
		}
		suffix := "s"
		if asFloat(count) == 1 {
			suffix = ""
		}
		return "for Transport capacity" + qualification + ", " + eachModel + " counts as " + ejstr(count) + " " + equivalent + suffix
	}

	models := asFloat(m["models_per_group"])
	spaces := asFloat(m["spaces_per_group"])
	groupModel := "model in this unit"
	groupModels := "models in this unit"
	if keyword != "" {
		groupModel = keyword + " model"
		groupModels = keyword + " models"
	}
	if singleModel {
		groupModel = model
		groupModels = model
	}
	subject := "each group of " + ejstr(m["models_per_group"]) + " " + groupModels
	if models == 1 {
		subject = "each " + groupModel
	}
	if singleModel {
		subject = model
	}
	spaceNoun := "model spaces"
	if spaces == 1 {
		spaceNoun = "model space"
	}
	return "for Transport capacity" + qualification + ", " + subject + " occupies " + ejstr(m["spaces_per_group"]) + " " + spaceNoun + ", rounding " + ejstr(m["rounding"])
}

func persistentDesignationName(designation any, scope any) string {
	label := titleCase(ejstr(designation))
	if scope == "objective-marker" {
		if strings.HasSuffix(label, " Marker") {
			return "your " + label
		}
		return "your " + label + " Marker"
	}
	if label == "Target" || strings.HasSuffix(label, " Target") {
		return "your " + label
	}
	return "your " + label + " target"
}

func persistentDesignationLabel(designation any, scope any) string {
	return " (" + persistentDesignationName(designation, scope) + ")"
}

func persistentDesignationSupported(e map[string]any) bool {
	sel, _ := asMap(e["select"])
	consumer, _ := asMap(e["consumer"])
	if consumer["beneficiary"] != "bearer" {
		return false
	}
	return (sel["scope"] == "enemy-unit" && consumer["relation"] == "attacks-selected-unit") ||
		(sel["scope"] == "objective-marker" && consumer["relation"] == "within-selected-marker")
}

func persistentDesignationLead(e map[string]any) string {
	sel, _ := asMap(e["select"])
	scopeNoun := "enemy unit"
	if sel["scope"] == "objective-marker" {
		scopeNoun = "objective marker"
	}
	label := persistentDesignationLabel(e["designation"], sel["scope"])
	selectLead := "select"
	if truthy(sel["timing"]) {
		selectLead = describeTiming(sel["timing"]) + ", select"
	}
	return selectLead + " one " + scopeNoun + label + "."
}

func persistentDesignationWhen(e map[string]any) string {
	sel, _ := asMap(e["select"])
	consumer, _ := asMap(e["consumer"])
	name := persistentDesignationName(e["designation"], sel["scope"])
	relation := "each time this model makes an attack against it"
	if consumer["relation"] == "within-selected-marker" {
		relation = "while this model is within range of " + name
	}
	_, trail := durationClauses(e["duration"])
	if trail == "" {
		return relation
	}
	return capitalize(trail) + ", " + relation
}
func leaderModelAbilityGrantClause(e map[string]any, ctx map[string]any) string {
	filter, _ := asMap(e["leader_filter"])
	identity := ""
	if filter != nil && truthy(filter["identity"]) {
		identity = " identified as " + titleCase(ejstr(filter["identity"]))
	}
	var keywords []string
	if filter != nil {
		for _, keyword := range getStrList(filter, "keywords") {
			keywords = append(keywords, bracketKeyword(keyword))
		}
	}
	role := "the attached leader model"
	if e["beneficiary"] == "attached-character-leader" {
		role = "the attached CHARACTER leader model"
	}
	leader := role + identity
	if len(keywords) > 0 {
		leader += " with " + strings.Join(keywords, " and ")
	}
	var unitKeywords []string
	for _, keyword := range getStrList(e, "attached_unit_filter") {
		unitKeywords = append(unitKeywords, bracketKeyword(keyword))
	}
	source := "the bearer unit"
	if len(unitKeywords) > 0 {
		source += " with " + strings.Join(unitKeywords, " and ")
	}
	grant, _ := asMap(e["grant"])
	nested, _ := getMap(grant, "effect")
	nested = cloneMap(nested)
	nested["target"] = "self"
	rendered := strings.Replace(describeEffectInline(nested, ctx), "this model", "that leader model", 1)
	return "while " + leader + " leads " + source + ", " + rendered
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

// resourceNoun renders a player-facing noun for a resource-gain/resource-spend/
// resource-clear modifier's pool, or a menu action's cost. resource_label (a
// singular noun, e.g. "Battle Focus token") is an author-provided override
// that pluralizes by count and never leaks the internal pool_id; absent,
// falls back to the established poolName title-casing (backward compatible
// with every pre-existing resource node).
func resourceNoun(m map[string]any, count any) string {
	label, ok := m["resource_label"].(string)
	if !ok || label == "" {
		pool := m["pool_id"]
		if pool == nil {
			pool = m["resource"]
		}
		return poolName(pool)
	}
	if f, ok := num(count); ok && f == 1 {
		return label
	}
	return label + "s"
}

// menuActionSubject renders excludes_keyword/requires_keyword as the
// eligible-unit noun phrase for a menu action ("one friendly non-TITANIC
// unit" / "a friendly VEHICLE unit"). Absent eligibility keywords fall back
// to the plain subject.
func menuActionSubject(elig map[string]any) string {
	requires := getStrList(elig, "requires_keyword")
	excludes := getStrList(elig, "excludes_keyword")
	if len(excludes) > 0 {
		return "one friendly non-" + strings.Join(excludes, "/") + " unit"
	}
	if len(requires) > 0 {
		return "a friendly " + strings.Join(requires, " ") + " unit"
	}
	return "the unit"
}

// menuActionEligibilityClause renders a menu action's eligibility as a
// trailing parenthetical naming which unit may use it and any extra
// requirements (eligibility.requires conditions, rendered via the shared
// describeCondition and joined with "and"). "" when the action is open to
// any unit with no further gate.
func menuActionEligibilityClause(elig map[string]any) string {
	if elig == nil {
		return ""
	}
	requires := getStrList(elig, "requires_keyword")
	excludes := getStrList(elig, "excludes_keyword")
	hasKeywordGate := len(requires) > 0 || len(excludes) > 0
	var requirementPhrases []string
	for _, c := range getList(elig, "requires") {
		cm, _ := asMap(c)
		requirementPhrases = append(requirementPhrases, describeCondition(cm))
	}
	if !hasKeywordGate && len(requirementPhrases) == 0 {
		return ""
	}
	var parts []string
	if hasKeywordGate {
		parts = append(parts, "only usable by "+menuActionSubject(elig))
	}
	if len(requirementPhrases) > 0 {
		parts = append(parts, strings.Join(requirementPhrases, " and "))
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}

// menuActionDurationClause renders a menu action's duration as a trailing
// clause. "immediate" (and absent) render with NO clause — a one-off action
// whose only lasting result is the board position it leaves behind.
func menuActionDurationClause(duration any) string {
	switch duration {
	case "until-end-of-phase":
		return "until the end of the phase"
	case "until-end-of-turn":
		return "until the end of the turn"
	default:
		return ""
	}
}

// describeMenuAction renders one resource-action-menu action as a bullet
// body ("Label: trigger, spend N tokens, effect, duration (notes).").
func describeMenuAction(a map[string]any, ctx map[string]any) string {
	label := a["label"]
	if label == nil {
		label = a["id"]
	}
	var trigParts []string
	for _, t := range normalizeTriggers(a["when"]) {
		if s := describeReactiveTrigger(t); s != "" {
			trigParts = append(trigParts, s)
		}
	}
	trig := strings.Join(trigParts, " or ")
	cost, _ := getMap(a, "cost")
	costPhrase := "spend " + ejstr(cost["amount"]) + " " + resourceNoun(cost, cost["amount"])
	effEff, _ := getMap(a, "effect")
	effClause := describeEffectInline(effEff, ctx)
	durClause := menuActionDurationClause(a["duration"])
	usageNote := ""
	if usage, ok := getMap(a, "usage"); ok && truthy(usage["repeatable_if_different_unit"]) {
		usageNote = " (may be triggered more than once per phase if a different unit performs it each time)"
	}
	elig, _ := getMap(a, "eligibility")
	body := joinNonEmpty([]string{
		trig + menuActionEligibilityClause(elig),
		costPhrase,
		effClause,
		durClause,
	}, ", ")
	return ejstr(label) + ": " + body + usageNote + "."
}

// sharedUsageClause renders shared_usage as a menu-level sentence fragment
// ("a unit may perform at most one action per phase; unless stated
// otherwise, a given action may be triggered once per phase"). "" when
// absent.
func sharedUsageClause(su map[string]any) string {
	if su == nil {
		return ""
	}
	var parts []string
	if unitMax, ok := num(su["unit_max_manoeuvres_per_phase"]); ok {
		if unitMax == 1 {
			parts = append(parts, "a unit may perform at most one action per phase")
		} else {
			parts = append(parts, "a unit may perform at most "+ejstr(su["unit_max_manoeuvres_per_phase"])+" actions per phase")
		}
	}
	if defaultMax, ok := num(su["default_manoeuvre_max_per_phase"]); ok {
		if defaultMax == 1 {
			parts = append(parts, "unless stated otherwise, a given action may be triggered once per phase")
		} else {
			parts = append(parts, "unless stated otherwise, a given action may be triggered up to "+ejstr(su["default_manoeuvre_max_per_phase"])+" times per phase")
		}
	}
	return strings.Join(parts, "; ")
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
		strings.HasPrefix(subj, "enemy units") || strings.HasPrefix(subj, "friendly units") ||
		strings.HasPrefix(subj, "targets ")
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
	} else if ctx["scope_range"] == "any-visible" {
		within = " that are visible"
	} else if ctx["scope_range"] == "any-on-battlefield" {
		within = " anywhere on the battlefield"
	}
	switch target {
	case "self", "bearer":
		return "this model"
	case "unit":
		if ctx["selected_model"] == true {
			return "that model"
		}
		if ctx["selected_unit"] == true {
			return "that unit"
		}
		return "the unit"
	case "attached-unit":
		return "the unit this model leads"
	case "selected-models-unit":
		return "that model's unit"
	case "target":
		if ctx["selected_target"] == true {
			return "that unit"
		}
		return "the target"
	case "attacker":
		return "the attacking unit"
	case "defender":
		// The defending unit in an attack is the enemy from the bearer's view.
		return "the target"
	case "targets-of-selected-unit-attacks":
		selected := "unit"
		if ctx["selected_model"] == true {
			selected = "model"
		}
		return "targets of that " + selected + "'s attacks"
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

// ofOrPossessive renders "<subj>'s <rest>" for a simple subject, or
// "the <rest> of <subj>" when the subject is a clause (an aura target ending in
// an inch mark), where a trailing possessive reads as garbage
// (`friendly units within 6"'s weapons`).
func ofOrPossessive(subj, rest string) string {
	if strings.HasSuffix(subj, "\"") {
		return "the " + rest + " of " + subj
	}
	return possessive(subj) + " " + rest
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
	case "attack-sequence":
		return "", "until that unit finishes resolving its attacks"
	case "resolution":
		return "", "when resolving this use"
	case "phase":
		return "", "until the end of the phase"
	case "turn":
		return "", "until the end of the turn"
	case "battle":
		return "", "for the rest of the battle"
	case "battle-round":
		return "", "until the end of the battle round"
	case "until-next-command-phase":
		return "", "until the start of your next Command phase"
	case "until-next-movement-phase":
		return "", "until the start of your next Movement phase"
	case "until-next-battle-round":
		return "", "until the start of the next battle round"
	case "until-start-next-turn":
		return "", "until the start of your next turn"
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
		if om["negated"] != true && om["type"] == "unit-has-keyword" {
			var kws []string
			for i < len(operands) {
				m, _ := asMap(operands[i])
				if m["negated"] != true && m["type"] == "unit-has-keyword" {
					mp, _ := getMap(m, "parameters")
					kws = append(kws, ejstr(mp["keyword"]))
					i++
				} else {
					break
				}
			}
			if len(kws) >= 2 {
				parts = append(parts, "if the unit is a "+strings.Join(kws, " ")+" unit")
			} else {
				parts = append(parts, "if the unit has the "+kws[0]+" keyword")
			}
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

// joinOrLeadIns preserves generic recursive behavior for mixed or negated
// operands, but compacts an all-positive unit-keyword OR into the shared
// keyword-list wording.
func joinOrLeadIns(operands []any) string {
	kws := make([]string, 0, len(operands))
	for _, operand := range operands {
		om, _ := asMap(operand)
		if om["negated"] == true || om["type"] != "unit-has-keyword" {
			kws = nil
			break
		}
		mp, _ := getMap(om, "parameters")
		kws = append(kws, ejstr(mp["keyword"]))
	}
	if kws != nil {
		return "if the unit has the " + orList(kws) + " keywords"
	}
	parts := make([]string, len(operands))
	for i, operand := range operands {
		om, _ := asMap(operand)
		parts[i] = conditionLeadIn(om)
	}
	return strings.Join(parts, " or ")
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
			return joinOrLeadIns(operands)
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
	if c["negated"] == true && c["type"] == "timing-is" {
		return negatedTiming(p["timing"])
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
		return "while this model is leading a " + kw + "unit"
	case "timing-is":
		return describeTiming(p["timing"])
	case "player-turn-is":
		switch p["turn"] {
		case "your-turn", "your", "own":
			return "in your turn"
		case "opponent-turn", "opponent":
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
		bMin, hasMin := parseNumber(p["min"])
		bMax, hasMax := parseNumber(p["max"])
		switch {
		case hasMin && hasMax:
			if bMin == bMax {
				return "during the " + bordinal(bMin) + " battle round"
			}
			return "during battle rounds " + numStr(bMin) + "-" + numStr(bMax)
		case hasMin:
			return "from the " + bordinal(bMin) + " battle round onward"
		case hasMax:
			return "during the first " + numStr(bMax) + " battle rounds"
		}
		return "during the battle round"
	case "token-count-at-or-above":
		return "while the unit has " + ejstr(p["threshold"]) + "+ " + poolName(p["pool_id"])
	case "remained-stationary":
		return "if the unit Remained Stationary"
	case "target-has-keyword":
		return "against " + ejstr(p["keyword"]) + " targets"
	case "unit-has-keyword":
		return "if the unit has the " + ejstr(p["keyword"]) + " keyword"
	case "unit-model-count":
		return "if the unit contains " + ejstr(p["count_min"]) + "+ " + ejstr(p["keyword"]) + " models"
	case "uniform-ranged-loadout":
		keyword := ""
		if p["model_keyword"] != nil {
			keyword = ejstr(p["model_keyword"]) + " "
		}
		return "if all ranged weapons equipped by each " + keyword + "model in the unit are the same"
	case "all-attacks-target-same-unit":
		attackType := ""
		if p["attack_type"] != nil {
			attackType = ejstr(p["attack_type"]) + " "
		}
		return "when all of the unit's " + attackType + "attacks target the same enemy unit"
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
		if ejstr(p["attack_type"]) == "any" {
			return "when destroyed by any attack"
		}
		return "when destroyed by a " + ejstr(p["attack_type"]) + " attack"
	case "opponent-unit-within-range":
		var where string
		rng := p["range"]
		if rng == nil {
			rng = p["range_inches"]
		}
		if rng == nil {
			rng = p["within_inches"]
		}
		switch {
		case p["weapon_name"] != nil:
			where = "range of " + dekebab(ejstr(p["weapon_name"]))
		case p["range_multiplier"] != nil:
			where = "half range of its ranged weapons"
		case rng == "engagement":
			where = "engagement range"
		default:
			where = ejstr(rng) + "\""
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
	"enemy-models-in-range":           "enemy models",
	"friendly-models-in-range":        "friendly models",
	"models-in-bearer-unit":           "models in this unit",
	"models-in-or-embarked-in-bearer": "models in or embarked within this model",
	"enemy-units-in-range":            "enemy units",
	"wounds-lost":                     "wounds lost",
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

func orList(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	case 2:
		return items[0] + " or " + items[1]
	}
	return strings.Join(items[:len(items)-1], ", ") + " or " + items[len(items)-1]
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

// battleRoundOrdinals indexes a battle-round number to its ordinal word; out of
// range falls back to "<n>th" (mirrors the bOrd helper in effect.ts/condition.ts).
var battleRoundOrdinals = []string{"zeroth", "first", "second", "third", "fourth", "fifth"}

func bordinal(n float64) string {
	if n >= 0 && n == float64(int(n)) && int(n) < len(battleRoundOrdinals) {
		return battleRoundOrdinals[int(n)]
	}
	return numStr(n) + "th"
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
		return "add " + diceCase(ejstr(dist)) + " to " + ofOrPossessive(subj, "Advance rolls")
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
		return ofOrPossessive(subj, "Move characteristic") + " is reduced by " + numStr(-n) + "\""
	}
	if moveKinds != "" {
		return "add" + inches + " to " + ofOrPossessive(subj, moveKinds+" moves")
	}
	return subj + " can make a Normal move" + ofUpTo
}

// auraClause renders a generic aura `modifier` as one lowercase-initial clause.
// Mirror of _aura_clause in python .../translate/effect.py.
func keywordFilterClause(value any, noun string) string {
	filter, ok := asMap(value)
	if !ok || filter == nil {
		return noun
	}
	var required []string
	for _, k := range getStrList(filter, "required_keywords") {
		required = append(required, k)
	}
	var excluded []string
	for _, k := range getStrList(filter, "excluded_keywords") {
		excluded = append(excluded, k)
	}
	result := noun
	if len(required) > 0 {
		result += " with " + strings.Join(required, " and ")
	}
	if len(excluded) > 0 {
		result += " without " + strings.Join(excluded, " or ")
	}
	return result
}

var auraNestedSubjectRe = regexp.MustCompile(`^the unit\b\s*`)

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
	if rng, ok := asList(m["range"]); ok {
		parts := make([]string, len(rng))
		for i, r := range rng {
			parts[i] = ejstr(r) + "\""
		}
		rangeText = strings.Join(parts, "/") + " (by battle round)"
	} else if m["range"] != nil {
		rangeText = ejstr(m["range"]) + "\""
	}
	owner := "enemy"
	if e["target"] == "friendly-within-aura" {
		owner = "friendly"
	}
	eligible, _ := getMap(m, "eligible")
	who := "each " + owner
	if required := getStrList(eligible, "required_keywords"); len(required) > 0 {
		who += " " + strings.Join(required, " ")
	}
	who += " unit"
	if excluded := getStrList(eligible, "excluded_keywords"); len(excluded) > 0 {
		who += " (excluding " + strings.Join(excluded, " ") + " units)"
	}
	recipientFilter := m["recipient_filter"]
	emitterFilter := m["emitter_filter"]
	recipient := keywordFilterClause(recipientFilter, who)
	within := recipient
	if rangeText != "" {
		within += " within " + rangeText
	}
	filtered := emitterFilter != nil || recipientFilter != nil
	effectText := ""
	if inner, ok := getMap(m, "effect"); ok && inner != nil {
		ctxCopy := make(map[string]any, len(ctx)+1)
		for k, val := range ctx {
			ctxCopy[k] = val
		}
		if m["eligible"] != nil || filtered {
			ctxCopy["selected_unit"] = true
		}
		nested := describeEffectInline(inner, ctxCopy)
		if filtered {
			effectText = ", and each such unit " + auraNestedSubjectRe.ReplaceAllString(nested, "")
		} else {
			effectText = " " + nested
		}
	} else if filtered {
		effectText = ", and each such unit is affected"
	} else {
		effectText = " is affected"
	}
	if emitterFilter != nil {
		emitter := keywordFilterClause(emitterFilter, "this model")
		return emitter + " projects an aura to " + within + effectText
	}
	return within + effectText
}

func namedRegionTitle(v any) string {
	return titleCase(cstr(v))
}

func namedRegionRelation(v any) string {
	if v == "wholly-within" {
		return "wholly within"
	}
	return dekebab(cstr(v))
}

func namedRegionKeywords(v any) string {
	values, ok := asList(v)
	if !ok {
		return "?"
	}
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = ejstr(value)
	}
	return strings.Join(parts, " or ")
}

func namedRegionPrefix(m map[string]any) string {
	ref, _ := asMap(m["region_ref"])
	region := namedRegionTitle(ref["region_id"])
	producer, _ := asMap(m["producer"])
	sentences := []string{}
	if entries, ok := asList(producer["baseline"]); ok {
		for _, raw := range entries {
			entry, _ := asMap(raw)
			zone := ejstr(entry["zone"])
			switch zone {
			case "own-deployment-zone":
				sentences = append(sentences, "Your deployment zone is always within "+region+".")
			case "?":
			default:
				sentences = append(sentences, namedRegionTitle(zone)+" is always within "+region+".")
			}
		}
	}
	hasPhaseExtension := false
	if entries, ok := asList(producer["phase_extensions"]); ok {
		for _, raw := range entries {
			entry, _ := asMap(raw)
			zone := ejstr(entry["zone"])
			switch zone {
			case "no-mans-land":
				sentences = append(sentences, "At the start of each phase, No Man's Land is within "+region+" until the end of that phase if you control at least half of its objective markers.")
				hasPhaseExtension = true
			case "opponent-deployment-zone":
				if hasPhaseExtension {
					sentences = append(sentences, "The same applies separately to your opponent's deployment zone.")
				} else {
					sentences = append(sentences, "At the start of each phase, your opponent's deployment zone is within "+region+" until the end of that phase if you control at least half of its objective markers.")
				}
				hasPhaseExtension = true
			case "?":
			default:
				label := namedRegionTitle(zone)
				sentences = append(sentences, "At the start of each phase, "+label+" is within "+region+" until the end of that phase if you control at least half of its objective markers.")
				hasPhaseExtension = true
			}
		}
	}
	sourceParts := []string{}
	seenSourceParts := map[string]struct{}{}
	if entries, ok := asList(producer["additive_extensions"]); ok {
		for _, raw := range entries {
			addition, _ := asMap(raw)
			gate, _ := asMap(addition["source_gate"])
			predicate, _ := asMap(gate["unit_predicate"])
			if len(predicate) == 0 {
				continue
			}
			if addition["kind"] == "unit-proximity" {
				keywords := strings.Join(getStrList(predicate, "keywords"), " and ")
				sentences = append(sentences, "The area within "+ejstr(addition["radius_inches"])+"\" of one or more friendly "+keywords+" units is within "+region+", continuously as those units move.")
				continue
			}
			faction := namedRegionTitle(predicate["faction"])
			keywords := namedRegionKeywords(predicate["keywords"])
			radius := ""
			if addition["radius_inches"] != nil {
				radius = ` within ` + ejstr(addition["radius_inches"]) + `"`
			}
			rendered := faction + " units with " + keywords + radius
			if _, duplicate := seenSourceParts[rendered]; duplicate {
				continue
			}
			seenSourceParts[rendered] = struct{}{}
			sourceParts = append(sourceParts, rendered)
		}
	}
	if len(sourceParts) > 0 {
		sentences = append(sentences, "Selected objective markers extend "+region+" around "+strings.Join(sourceParts, " or ")+".")
	}
	return strings.Join(sentences, " ")
}

func namedRegionSubject(m map[string]any) string {
	consumer, _ := asMap(m["consumer"])
	gate, _ := asMap(consumer["beneficiary_gate"])
	faction := ""
	if gate["faction"] != nil {
		faction = namedRegionTitle(gate["faction"])
	}
	factionPart := " from your army"
	if faction != "" {
		factionPart = " from your " + faction + " army"
	}
	return "Models in " + namedRegionKeywords(gate["keywords"]) + " units" + factionPart
}

func namedRegionBranchEffect(branch map[string]any, qualified bool, ctx map[string]any) string {
	effect, _ := asMap(branch["effect"])
	modifier, _ := asMap(effect["modifier"])
	roll := rollName(modifier["roll"])
	text := ""
	switch getStr(effect, "type") {
	case "re-roll":
		if modifier["result_scope"] == "any-result" {
			text = "can re-roll the " + roll + " roll"
		} else if modifier["subset"] == "ones" {
			text = "can re-roll " + roll + " rolls of 1"
		} else {
			text = "can re-roll " + roll + " rolls"
		}
	case "roll-modifier":
		if modifier["value"] != nil {
			text = "gets " + esigned(modifier["operation"], modifier["value"]) + " to " + roll
		}
	}
	if text == "" {
		text = describeEffectInline(effect, ctx)
	}
	if branch["optional"] == false {
		text = strings.Replace(text, "can re-roll", "re-roll", 1)
	}
	if modifier["weapon_keyword"] != nil {
		prefix := ""
		if qualified {
			prefix = "those "
		}
		text += " for " + prefix + ejstr(modifier["weapon_keyword"]) + " attacks"
	}
	return text
}

func namedRegionBranch(m map[string]any, wholeUnit, qualified, conditional bool, ctx map[string]any) string {
	consumer, _ := asMap(m["consumer"])
	key := "default_branch"
	if qualified {
		key = "qualified_branch"
	}
	branch, _ := asMap(consumer[key])
	effect := namedRegionBranchEffect(branch, qualified, ctx)
	if conditional {
		return namedRegionSubject(m) + " " + effect
	}
	if !qualified {
		return namedRegionSubject(m) + " " + effect + "."
	}
	if condition, ok := getMap(consumer, "qualified_condition"); ok && condition["operator"] != nil {
		return "If " + describeCondition(condition) + ", those models " + effect + " instead"
	}
	membership, _ := asMap(consumer["membership"])
	ref, _ := asMap(m["region_ref"])
	region := namedRegionTitle(ref["region_id"])
	relation := namedRegionRelation(membership["relation"])
	subject := "If such a model is " + relation + " " + region + ", it"
	if wholeUnit {
		subject = "If such a unit is " + relation + " " + region + ", those models"
	}
	return subject + " " + effect + " instead"
}

func describeNamedRegionState(m map[string]any, ctx map[string]any) string {
	consumer, _ := asMap(m["consumer"])
	membership, _ := asMap(consumer["membership"])
	wholeUnit := membership["unit_scope"] == "whole-unit"
	attackGate := ""
	if condition, ok := getMap(consumer, "attack_condition"); ok && condition != nil {
		attackGate = "For each qualifying attack (" + describeCondition(condition) + "): "
	}
	return namedRegionPrefix(m) + " " + attackGate + namedRegionBranch(m, wholeUnit, false, false, ctx) + " " + namedRegionBranch(m, wholeUnit, true, false, ctx)
}

func describeNamedRegionConditional(m map[string]any, condition map[string]any, ctx map[string]any) string {
	consumer, _ := asMap(m["consumer"])
	membership, _ := asMap(consumer["membership"])
	wholeUnit := membership["unit_scope"] == "whole-unit"
	positive := map[string]any{"type": "region-membership", "parameters": condition["parameters"]}
	predicate := describeCondition(positive)
	defaultText := namedRegionBranch(m, wholeUnit, false, true, ctx)
	qualifiedText := namedRegionBranch(m, wholeUnit, true, true, ctx)
	if condition["negated"] == true {
		return namedRegionPrefix(m) + " Unless " + predicate + ", " + defaultText + ". If " + predicate + ", " + qualifiedText + "."
	}
	return namedRegionPrefix(m) + " When " + predicate + ", " + qualifiedText + ". Otherwise, " + defaultText + "."
}

// describeEffectInline wraps the leaf/container switch to weave on any `scaling` block.
func describeEffectInline(e map[string]any, ctx map[string]any) string {
	base := describeEffectInlineBase(e, ctx)
	if effect, ok := getMap(e, "after_move"); e["type"] == "movement-modifier" && ok && effect != nil {
		base += "; if it does, " + describeEffectInline(effect, ctx)
	}
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
		if m["stat"] != nil && (m["weapon_type"] != nil || m["weapon_name"] != nil || m["weapon_keyword"] != nil) {
			equipment := weaponNoun(m) + " equipped by " + weaponHolder(e["target"], ctx)
			stat := statName(m["stat"])
			if m["operation"] == "set" {
				return "set the " + stat + " characteristic of " + equipment + " to " + ejstr(m["value"])
			}
			if m["operation"] == "improve" {
				return "improve the " + stat + " characteristic of " + equipment + " by " + ejstr(m["value"])
			}
			if !isNumber(m["value"]) {
				verb, prep := "add", "to"
				if m["operation"] == "subtract" || m["operation"] == "worsen" {
					verb, prep = "subtract", "from"
				}
				return verb + " " + ejstr(m["value"]) + " " + prep + " the " + stat + " characteristic of " + equipment
			}
			amount := asFloat(m["value"])
			if m["operation"] == "subtract" || m["operation"] == "worsen" {
				amount = -amount
			}
			verb, prep := "add", "to"
			if amount < 0 {
				verb, prep, amount = "subtract", "from", -amount
			}
			return verb + " " + ejstr(amount) + " " + prep + " the " + stat + " characteristic of " + equipment
		}
		scope := ""
		if truthy(m["attack_type"]) {
			scope = " (" + ejstr(m["attack_type"]) + ")"
		}
		if m["stat"] == nil {
			return "modify " + ofOrPossessive(subj, "characteristics") + scope
		}
		if m["operation"] == "set" {
			return "modify " + ofOrPossessive(subj, statName(m["stat"])+" characteristic") + " to " + ejstr(m["value"]) + scope
		}
		if m["operation"] == "improve" {
			return "improve " + ofOrPossessive(subj, statName(m["stat"])+" characteristic") + " by " + ejstr(m["value"]) + scope
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
		return verb + " " + ejstr(val) + " " + prep + " " + ofOrPossessive(subj, statName(m["stat"])+" characteristic") + scope
	case "roll-modifier":
		ctxNote := ""
		if m["context"] != nil && truthy(m["context"]) {
			ctxNote = " (" + ejstr(m["context"]) + ")"
		}
		ctxNote += weaponRollScope(m)
		rollValue := m["roll"]
		if rollValue == nil {
			rollValue = m["test"]
		}
		roll := rollName(rollValue)
		if m["critical_on"] != nil {
			crit := "Critical Hits"
			if rollValue == "wound" {
				crit = "Critical Wounds"
			}
			return subj + " " + ev(subj, "scores") + " " + crit + " on " + roll + " rolls of " + ejstr(m["critical_on"]) + "+"
		}
		if m["operation"] == "set" {
			return subj + " can change " + roll + " rolls to a " + ejstr(m["value"])
		}
		if m["value"] == nil {
			return dekebab(ejstr(m["operation"])) + " " + ofOrPossessive(subj, roll+" rolls") + ctxNote
		}
		return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to " + roll + " rolls" + ctxNote
	case "re-roll":
		var which string
		if ejstr(m["roll"]) == "any" {
			which = "any roll"
			if m["subset"] == "ones" {
				which = "any roll of 1"
			}
		} else {
			noun := rollName(m["roll"])
			which = "the " + noun + " roll"
			if m["subset"] == "ones" {
				which = "a " + noun + " roll of 1"
			}
		}
		permission := "you can re-roll"
		if m["optional"] == false {
			permission = "re-roll"
		}
		owner := ""
		if e["target"] == "self" || e["target"] == "bearer" || ctx["selected_model"] == true {
			owner = " for "
			if m["roll"] == "hit" || m["roll"] == "wound" || m["roll"] == "damage" {
				owner += "attacks made by "
			}
			owner += weaponHolder(e["target"], ctx)
		}
		return permission + " " + which + owner + weaponRollScope(m)

	case "mortal-wounds":
		return describeMortalWounds(e, m, subj, ctx)
	case "feel-no-pain":
		vs := ""
		switch m["scope"] {
		case "mortal":
			vs = " against mortal wounds"
		case "psychic":
			vs = " against Psychic Attacks"
		case "psychic-and-mortal":
			vs = " against Psychic Attacks and mortal wounds"
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
		if m["weapon_type"] != nil || m["weapon_name"] != nil || m["weapon_keyword"] != nil {
			return weaponNoun(m) + " equipped by " + weaponHolder(e["target"], ctx) + " gain " + kw
		}
		return ofOrPossessive(subj, "weapons") + " gain " + kw
	case "detection-range-modifier":
		return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to detection range"
	case "hazard-rolls":
		penalty := ""
		if m["roll_modifier_if_battle_shocked"] != nil {
			penalty = ", with " + esigned("add", m["roll_modifier_if_battle_shocked"]) +
				" to those rolls while " + subj + " " + ev(subj, "is") + " Battle-shocked"
		}
		return subj + " " + ev(subj, "makes") + " " + ejstr(m["additional_per_engaged_unit"]) +
			" additional Hazard rolls for each " + titleCase(ejstr(m["engaged_keyword"])) +
			" unit " + pronoun(subj) + " " + ev(subj, "is") + " engaged with" + penalty
	case "ability-grant":
		grant := m["grant_type"]
		if grant == nil {
			grant = m["ability_id"]
		}
		// Reserves-arrival grant slugs read as full clauses in GW voice — the
		// generic "gains the X ability" form would bury the mechanic in a name.
		switch ejstr(grant) {
		case "shoot-after-advance":
			return subj + " is eligible to shoot in a turn in which it Advanced"
		case "charge-after-advance":
			return subj + " is eligible to declare a charge in a turn in which it Advanced"
		case "must-start-in-reserves":
			return subj + " must start the battle in Reserves"
		case "reinforcement-any-of-turns-1-to-3":
			return subj + " can be set up in the Reinforcements step of your first, second or third Movement phase, regardless of any mission rules"
		case "reserves-limit-exempt":
			return subj + " " + ev(subj, "is") + " not counted towards any limits on the number of units that can start the battle in Reserves"
		case "reserves-limit-exempt-with-cargo":
			return "neither " + subj + " nor any units embarked within it are counted towards any limits on the number of units that can start the battle in Reserves"
		case "may-start-in-reserves":
			return subj + " can start the battle in Reserves"
		case "battle-round-plus-one-for-arrival":
			return subj + " " + ev(subj, "treats") + " the current battle round number as being one higher than it actually is when arriving from Reserves"
		case "flavor-text":
			return "this ability is a descriptive note (no additional rules effect)"
		case "crew-tokens":
			n := "1"
			if m["count"] != nil {
				n = ejstr(m["count"])
			}
			token := "Crew tokens"
			if m["token_name"] != nil {
				token = ejstr(m["token_name"]) + " tokens"
			}
			being := "it is"
			if pronoun(subj) == "their" {
				being = "they are"
			}
			return "place " + n + " " + token + " next to " + subj + " when " + being + " first set up, removing one each time " + subj + " " + ev(subj, "loses") + " a wound (the model itself represents " + pronoun(subj) + " final wound)"
		}
		cap := ""
		if m["capacity"] != nil {
			cap = " (" + ejstr(m["capacity"]) + ")"
		}
		// A grant's timing modifier scopes when the granted ability applies.
		when := ""
		if m["timing"] != nil {
			when = describeTiming(m["timing"]) + ", "
		}
		if grant != nil && m["enabled"] == false {
			return subj + " cannot use the " + grantLabel(ejstr(grant)) + " ability"
		}
		if grant != nil {
			return when + subj + " " + ev(subj, "gains") + " the " + grantLabel(ejstr(grant)) + " ability" + cap
		}
		return when + subj + " " + ev(subj, "gains") + " an ability" + cap
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
		if m["count_from"] != nil || m["bind_count_as"] != nil {
			count = "that many"
		}
		// type: "wounds" is a heal (regained wounds), not a revive.
		if m["type"] == "wounds" || m["wounds"] != nil {
			healed := count
			if m["count_from"] != nil {
				healed = "that many"
			} else if m["wounds"] != nil {
				healed = diceCase(m["wounds"])
			}
			noun := "lost wounds"
			if healed == "1" {
				noun = "lost wound"
			}
			return subj + " " + ev(subj, "regains") + " up to " + healed + " " + noun
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
	case "heal-wounds":
		amount := m["amount"]
		if amount == nil {
			amount = m["value"]
		}
		if amount == nil {
			amount = "1"
		}
		amountText := diceCase(amount)
		noun := "lost wounds"
		if amountText == "1" {
			noun = "lost wound"
		}
		return subj + " " + ev(subj, "regains") + " up to " + amountText + " " + noun
	case "recovery-pool":
		if e["target"] == "all-friendly" && truthy(m["per_target_unit"]) {
			return "roll " + diceCase(m["dice"]) + " recovery points independently for each friendly unit, first using them to regain lost wounds on wounded models and then using any remaining points to return destroyed models to the unit with 1 wound remaining, stopping when the unit is at full strength and all its models have their full wounds; any unallocated points are lost"
		}
		return "roll " + diceCase(m["dice"]) + " recovery points for the unit, first using them to regain lost wounds on wounded models and then using any remaining points to return destroyed models to the unit with 1 wound remaining, stopping when the unit is at full strength and all its models have their full wounds; any unallocated points are lost"
	case "stratagem-targeting-permission":
		if m["exception"] == "already-targeted-different-unit-this-phase" {
			return subj + " can be targeted with the " + titleCase(ejstr(m["stratagem"])) + " Stratagem even if a different unit has already been targeted with that Stratagem this phase"
		}
		if m["exception"] == "does-not-prevent-targeting-different-unit-this-phase" {
			return "after " + subj + " is targeted with the " + titleCase(ejstr(m["stratagem"])) + " Stratagem, a different unit can still be targeted with that Stratagem later in this phase"
		}
		if m["exception"] == "battle-shocked" {
			return subj + " can be targeted with Stratagems even while Battle-shocked"
		}
		return subj + " can be targeted with Stratagems"
	case "model-destruction":
		count := "1"
		if m["count"] != nil {
			count = diceCase(m["count"])
		}
		kind := "model"
		if m["model_keyword"] != nil {
			kind = titleCase(ejstr(m["model_keyword"])) + " model"
		}
		if count != "1" {
			kind += "s"
		}
		return "destroy " + count + " " + kind + " in " + subj
	case "named-region-state":
		return describeNamedRegionState(m, ctx)
	case "rule-state":
		return describeRuleState(m, subj)
	case "pool-add-die":
		pool := poolName(m["pool_id"])
		rolled := m["value"] == "rolled"
		if m["count_per_pool"] != nil {
			// One die per point currently in the counting pool (Icon of Khorne).
			per := poolName(m["count_per_pool"])
			perPlural := per
			if !strings.HasSuffix(per, "s") {
				perPlural = per + "s"
			}
			die := "one rolled D6"
			if !rolled {
				shown := "the highest result"
				if m["value"] != "highest" {
					shown = ejstr(m["value"])
				}
				die = "one die showing " + shown
			}
			tail := ""
			if m["consumes_pool"] == true {
				tail = ", after which all your " + perPlural + " are lost"
			}
			return "add " + die + " to your " + pool + " for each " + per + " you have" + tail
		}
		cnt := "1"
		if m["count"] != nil {
			cnt = diceCase(m["count"])
		}
		if rolled {
			dice := "a rolled D6"
			if cnt != "1" {
				dice = cnt + " rolled D6"
			}
			return "add " + dice + " to your " + pool
		}
		val := "the highest result"
		if m["value"] != "highest" {
			val = ejstr(m["value"])
		}
		dice := "a die"
		if cnt != "1" {
			dice = cnt + " dice"
		}
		return "add " + dice + " showing " + val + " to your " + pool
	case "replace-roll-from-pool":
		var rolls []string
		if arr, ok := m["rolls"].([]any); ok {
			for _, r := range arr {
				rolls = append(rolls, dekebab(ejstr(r)))
			}
		}
		return "discard a die from your " + poolName(m["pool_id"]) + " and substitute its value for a " + orList(rolls) + " roll"
	case "cp-gain":
		var a any = float64(1)
		if m["amount"] != nil {
			a = m["amount"]
		}
		return "you gain " + ejstr(a) + "CP"
	case "cp-on-destroy":
		kw := "enemy model"
		if m["enemy_keyword"] != nil {
			kw = ejstr(m["enemy_keyword"]) + " model"
		}
		who := subj
		if subj == "this model" {
			who = "this model's unit"
		}
		var amount any = float64(1)
		if m["amount"] != nil {
			amount = m["amount"]
		}
		return "each time " + who + " destroys a " + kw + ", you gain " + ejstr(amount) + "CP"
	case "battle-shock-test":
		if m["dice"] != nil {
			return subj + " " + ev(subj, "takes") + " Battle-shock tests on " + diceCase(m["dice"]) + " instead of 2D6"
		}
		if m["operation"] != nil && m["value"] != nil {
			return subj + " must make a Battle-shock roll with " + esigned(ejstr(m["operation"]), m["value"])
		}
		if m["roll_modifier"] != nil {
			return subj + " must make a Battle-shock roll with " + esigned("add", m["roll_modifier"])
		}
		return subj + " must make a Battle-shock roll"
	case "set-battle-shock":
		return subj + " " + ev(subj, "is") + " Battle-shocked"
	case "flyover":
		comp := "gte"
		if c, ok := m["comparison"].(string); ok && c != "" {
			comp = c
		}
		hit := poolThreshold(comp, m["threshold"])
		var per any = float64(1)
		if m["mortal_wounds"] != nil {
			per = m["mortal_wounds"]
		}
		perStr := ejstr(per)
		perNoun := "mortal wounds"
		if perStr == "1" {
			perNoun = "mortal wound"
		}
		return "each time this model ends a Normal move, select one enemy unit it moved over and roll " + diceCase(m["dice"]) + ": for each " + hit + ", that unit suffers " + perStr + " " + perNoun
	case "cp-refund":
		strat := "one Stratagem"
		if m["stratagem"] != nil {
			strat = "the " + titleCase(ejstr(m["stratagem"])) + " Stratagem"
		}
		return "you can use " + strat + " on " + subj + " for 0CP"
	case "modifier-immunity":
		scope := ejstr(m["scope"])
		if scope == "enemy-stratagems" {
			return subj + " cannot be affected by enemy Stratagems"
		}
		if scope == "enemy-abilities" {
			return subj + " cannot be affected by enemy abilities"
		}
		exc := ""
		if arr, ok := m["exclude"].([]any); ok && len(arr) > 0 {
			names := make([]string, len(arr))
			for i, s := range arr {
				names[i] = statName(s)
			}
			exc = " (except " + strings.Join(names, " and ") + ")"
		}
		return subj + " " + ev(subj, "ignores") + " any modifiers to " + pronoun(subj) + " characteristics" + exc
	case "no-effect":
		return "nothing happens"
	case "stratagem-cost-modifier":
		if m["applies_to"] == "triggering-stratagem-use" && m["operation"] == "decrease" {
			return "reduce the CP cost of that use of the Stratagem by " + ejstr(m["amount"]) + "CP (to a minimum of 0CP), before paying its cost"
		}
		which := "Stratagems"
		if m["stratagem"] != nil {
			which = "the " + titleCase(ejstr(m["stratagem"])) + " Stratagem"
		}
		whose := "that target " + subj
		if truthy(m["stratagem"]) {
			whose = "that targets " + subj
		}
		if m["applies_to"] == "stratagems-used-by-bearer" {
			whose = "used by " + subj
		}
		verb := "cost"
		if m["stratagem"] != nil {
			verb = "costs"
		}
		var val string
		if m["operation"] == "set-to" {
			val = ejstr(m["set_to"]) + "CP"
		} else {
			amount := "1"
			if m["amount"] != nil {
				amount = ejstr(m["amount"])
			}
			direction := "more"
			if m["operation"] == "decrease" {
				direction = "less"
			}
			val = amount + " " + direction + " CP"
		}
		return which + " " + whose + " " + verb + " " + val
	case "targeting-permission":
		at := "attacks"
		if m["attack_type"] == "ranged" {
			at = "ranged attacks"
		}
		r := "?"
		if m["range"] != nil {
			r = ejstr(m["range"]) + "\""
		}
		var gate string
		switch ejstr(m["gate"]) {
		case "within-range":
			gate = "the attacking unit is within " + r
		case "closest-eligible":
			gate = "it is the closest eligible target"
		case "closest-or-within-range":
			gate = "it is the closest eligible target or the attacking unit is within " + r
		default:
			gate = dekebab(ejstr(m["gate"]))
		}
		return subj + " can only be selected as the target of " + at + " if " + gate
	case "resource-gain":
		if m["count_mode"] == "by-battle-size" || m["count_by_battle_size"] != nil {
			return "you gain " + resourceNoun(m, nil) + " based on the current battle size (see the accompanying table)"
		}
		amount := m["amount"]
		if amount == nil {
			amount = m["value"]
		}
		return "you gain " + ejstr(amount) + " " + resourceNoun(m, amount)
	case "resource-spend":
		amount := m["amount"]
		if amount == nil {
			amount = m["value"]
		}
		base := "spend " + ejstr(amount) + " " + resourceNoun(m, amount)
		if capm, ok := m["cap"].(map[string]any); ok && capm["count"] != nil && capm["per"] != nil {
			return base + " (no more than " + ejstr(capm["count"]) + " per " + ejstr(capm["per"]) + ")"
		}
		return base
	case "resource-clear":
		scope := "all unspent"
		if m["scope"] == "all" {
			scope = "all"
		}
		return scope + " " + resourceNoun(m, 2.0) + " are lost"
	case "leadership-modifier":
		hasTest := m["test"] != nil
		if hasTest && m["operation"] == nil {
			return subj + " must take a " + testName(m["test"]) + " test"
		}
		if hasTest && m["operation"] == "re-roll" {
			return subj + " can re-roll " + testName(m["test"]) + " tests"
		}
		if hasTest && m["operation"] == "set" && m["test"] == "battle-shock" {
			return subj + " " + ev(subj, "is") + " Battle-shocked"
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
		return "modify " + ofOrPossessive(subj, "Leadership characteristic")
	case "tracking-token":
		token := titleCase(ejstr(m["token"])) + " token"
		if m["count_per_model"] != nil {
			model := "model"
			if m["model_keyword"] != nil {
				model = titleCase(ejstr(m["model_keyword"])) + " model"
			}
			finalWound := ""
			if truthy(m["model_represents_final_wound"]) {
				finalWound = "; each " + model + " represents its final wound"
			}
			return "place " + ejstr(m["count_per_model"]) + " " + token + "s next to each " + model + " in " + subj +
				"; remove one whenever that model loses a wound" + finalWound
		}
		count := any(float64(1))
		if m["count"] != nil {
			count = m["count"]
		}
		countText := ejstr(count)
		noun := token + "s"
		if countText == "1" {
			countText = "one"
			noun = token
		}
		placement := ""
		if m["placement"] == "next-to-target" {
			placement = " next to " + subj
		}
		return "place " + countText + " " + noun + placement + " as a reminder"
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
		// Without a to_keywords filter the grant lands on the effect subject.
		if m["to_keywords"] != nil {
			return ejstr(m["to_keywords"]) + " units gain the " + ejstr(m["keyword"]) + " keyword"
		}
		return subj + " " + ev(subj, "gains") + " the " + ejstr(m["keyword"]) + " keyword"
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
			return ofOrPossessive(subj, roll+" rolls") + " automatically succeed"
		case "fail":
			return ofOrPossessive(subj, roll+" rolls") + " automatically fail"
		}
		return ofOrPossessive(subj, roll+" rolls") + " count as " + ejstr(r)
	case "firing-deck":
		return subj + " " + ev(subj, "has") + " Firing Deck " + ejstr(m["value"])
	case "transport-capacity-conversion":
		return transportCapacityConversion(m)
	case "disembark":
		where := ""
		if m["distance"] != nil {
			where = " and be set up wholly within " + ejstr(m["distance"]) + "\" of the transport"
		}
		eng := ""
		if truthy(m["allow_engagement_range"]) {
			eng = ", even within Engagement Range of enemy units"
		}
		return subj + " can disembark" + where + eng
	case "disembark-after-move":
		if m["after"] == nil {
			return "units can disembark from " + subj + " after it has moved"
		}
		who := "units"
		if m["requires_keyword"] != nil {
			who = "units with the " + titleCase(ejstr(m["requires_keyword"])) + " ability"
		}
		var when string
		switch m["after"] {
		case "advance":
			when = "after it has Advanced"
		case "deployment":
			when = "after it has been set up on the battlefield"
		case "before-move":
			when = "before it moves"
		default:
			when = "after it has made a Normal move"
		}
		// `mandatory`: a Reserves-transport whose cargo MUST disembark on arrival.
		verb := "can disembark"
		if truthy(m["mandatory"]) {
			verb = "must immediately disembark"
		}
		away := ""
		if m["min_enemy_distance"] != nil {
			away = ", and must be set up more than " + ejstr(m["min_enemy_distance"]) + "\" away from all enemy models"
		}
		counts := ""
		if truthy(m["counts_as_normal_move"]) {
			counts = "; such units count as having made a Normal move"
		}
		// A deployment-step disembark has no meaningful charge window; only an
		// explicit can_charge renders the charge tail there.
		charge := ", but cannot declare a charge this turn"
		if truthy(m["can_charge"]) {
			charge = ", and are still eligible to declare a charge this turn"
		} else if m["after"] == "deployment" && m["can_charge"] == nil {
			charge = ""
		}
		return who + " " + verb + " from " + subj + " " + when + away + counts + charge
	case "unit-attachment":
		if truthy(m["mandatory"]) {
			return subj + " must be attached to a Leader, or it counts as destroyed"
		}
		led := ""
		if m["led_by"] != nil {
			led = " led by a " + titleCase(ejstr(m["led_by"])) + " model"
		}
		return "at the start of the Declare Battle Formations step, " + subj + " can join one friendly unit" + led + ", becoming part of that Bodyguard unit"
	case "fallback-and-act":
		acts := "shoot"
		if m["can_charge"] == true {
			acts = "shoot and declare a charge"
		}
		return subj + " " + ev(subj, "is") + " eligible to " + acts + " in a turn in which it Fell Back"
	case "fight-eligibility-extension":
		r := ejstr(m["range"])
		return "when determining which models in " + subj + " are eligible to fight, " +
			"models within " + r + "\" of one or more enemy models are eligible " +
			"and can target enemy units within " + r + "\""
	case "engagement-passthrough":
		var base string
		if truthy(m["no_end_in_engagement"]) {
			base = subj + " can move through enemy models, but cannot end that move within Engagement Range of any enemy unit"
		} else {
			base = subj + " can move through enemy models"
		}
		if moves, ok := asList(m["applies_to_moves"]); ok && len(moves) > 0 {
			parts := make([]string, len(moves))
			for i, x := range moves {
				xs := ejstr(x)
				if n, ok := moveNoun[xs]; ok {
					parts[i] = n
				} else {
					parts[i] = dekebab(xs)
				}
			}
			return base + ", during its " + andList(parts) + " moves"
		}
		return base
	case "attack-restriction":
		return describeAttackRestriction(m, subj)
	case "objective-control-modifier":
		if truthy(m["sticky"]) && m["retake"] == "opponent-control-greater-at-phase-end" {
			return "that objective marker remains under your control until, at the end of a phase, your opponent's Level of Control over it is greater than yours"
		}
		if truthy(m["sticky"]) {
			return subj + " " + ev(subj, "retains") + " control of objective markers even after no models remain in range, until the enemy retakes them (sticky objectives)"
		}
		if m["operation"] == "halve" {
			return "halve the Objective Control characteristic of " + subj
		}
		// An absolute set (Black Rage's OC 0) mirrors stat-modifier's wording.
		if m["operation"] == "set" {
			return "modify " + ofOrPossessive(subj, "Objective Control characteristic") + " to " + ejstr(m["value"])
		}
		if m["operation"] == "set" {
			return ofOrPossessive(subj, "Objective Control characteristic") + " is set to " + ejstr(m["value"])
		}
		if m["operation"] != nil {
			return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to " + pronoun(subj) + " Objective Control characteristic"
		}
		return "modify " + ofOrPossessive(subj, "Objective Control characteristic")
	case "bs-modifier":
		return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to Ballistic Skill"
	case "charge-roll-modifier":
		return subj + " " + ev(subj, "gets") + " " + esigned(m["operation"], m["value"]) + " to Charge rolls"
	case "terrain-area-tag":
		if m["tag"] != nil {
			return "the terrain area is marked as " + dekebab(ejstr(m["tag"]))
		}
		return "the terrain area is marked"
	case "objective-tag":
		if m["tag"] != nil {
			return "the objective is marked as " + dekebab(ejstr(m["tag"]))
		}
		return "the objective is marked"
	case "unit-tag":
		if m["tag"] != nil {
			return subj + " " + ev(subj, "is") + " marked as " + dekebab(ejstr(m["tag"]))
		}
		return subj + " " + ev(subj, "is") + " marked"
	case "conditional":
		cond, _ := getMap(e, "condition")
		inner, _ := getMap(e, "effect")
		if inner != nil && getStr(inner, "type") == "named-region-state" {
			modifier, _ := asMap(inner["modifier"])
			return describeNamedRegionConditional(modifier, cond, ctx)
		}
		return conditionLeadIn(cond) + ", " + describeEffectInline(inner, ctx)
	case "rules-bundle", "sequence":
		steps := getList(e, "steps")
		var parts []string
		for _, s := range steps {
			sm, _ := asMap(s)
			parts = append(parts, describeEffectInline(sm, ctx))
		}
		joined := strings.Join(parts, "; ")
		if prefix := sequenceBoundDicePrefix(steps); prefix != "" {
			return prefix + joined
		}
		return joined
	case "named-effect":
		level := ""
		if e["kind"] == "psychic" && e["level"] != nil {
			level = " (Psychic level " + ejstr(e["level"]) + ")"
		}
		prefix := ""
		if e["optional"] == true {
			prefix = "you can use "
		}
		inner, _ := getMap(e, "effect")
		return prefix + ejstr(e["name"]) + level + ": " + describeEffectInline(inner, ctx)
	case "choice":
		prompt, _ := e["choice_prompt"].(string)
		if prompt == "" {
			label := ""
			if cl, ok := e["choice_label"].(string); ok && cl != "" {
				label = " (" + titleCase(cl) + ")"
			}
			prompt = "select one of the following" + label
		}
		var opts []string
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			opts = append(opts, describeEffectInline(om, ctx))
		}
		return prompt + ": " + strings.Join(opts, " / ")
	case "dice-gated":
		return describeDiceGatedInline(e, ctx)
	case "dice-table":
		return describeDiceTableInline(e, ctx)
	case "dice-pool-allocation":
		return describeDicePoolInline(e, ctx)
	case "select-units":
		sel, _ := getMap(e, "selector")
		inner, _ := getMap(e, "effect")
		return selectUnitsInline(sel, inner, selectUnitsCtx(ctx, sel))
	case "leader-model-ability-grant":
		return leaderModelAbilityGrantClause(e, ctx)
	case "persistent-designation":
		if !persistentDesignationSupported(e) {
			return "[persistent-designation]"
		}
		consumer, _ := getMap(e, "consumer")
		inner, _ := getMap(consumer, "effect")
		return persistentDesignationLead(e) + " " + persistentDesignationWhen(e) + ", " + describeEffectInline(inner, ctx)
	case "for-each-unit":
		sel, _ := getMap(e, "selector")
		inner, _ := getMap(e, "effect")
		return "for each " + forEachUnitSubject(sel) + ": " + describeEffectInline(inner, forEachUnitCtx(ctx, sel))
	case "designate-target":
		sel, _ := asMap(e["select"])
		desig := ""
		if truthy(e["designation"]) {
			desig = designationLabel(e["designation"])
		}
		selectLead := "select"
		if truthy(sel["timing"]) {
			selectLead = describeTiming(sel["timing"]) + ", select"
		}
		_, durTrail := durationClauses(e["duration"])
		applies, _ := getMap(e, "applies")
		when := "each time a friendly unit attacks it"
		if keywords := getStrList(applies, "attacker_keywords"); len(keywords) > 0 {
			when = "each time a friendly " + strings.Join(keywords, " ") + " model attacks it"
		}
		if applies["to"] == "target" {
			when = "while it is your target"
		} else if applies["to"] == "bearer-attacks-target" {
			when = "each time this unit attacks it"
		}
		whenClause := when
		if durTrail != "" {
			whenClause = durTrail + ", " + when
		}
		appEff, _ := getMap(applies, "effect")
		return selectLead + " one " + designationTargetSubject(sel) + desig + "; " + whenClause + ", " + describeEffectInline(appEff, ctx)
	case "stance-select":
		var opts []string
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			oe, _ := getMap(om, "effect")
			opts = append(opts, ejstr(om["name"])+" ("+describeEffectInline(oe, ctx)+")")
		}
		return "select one: " + strings.Join(opts, " / ")
	case "risk-reward":
		risk, _ := getMap(e, "risk")
		onFail := "suffer a consequence"
		if rf, ok := getMap(risk, "on_fail"); ok && rf != nil {
			onFail = describeEffectInline(rf, ctx)
		}
		reward, _ := getMap(e, "reward")
		return "take a " + testName(risk["test"]) + " test (on a failure, " + onFail + "), then " + describeEffectInline(reward, ctx)
	case "issue-orders":
		var names []string
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			names = append(names, ejstr(om["name"]))
		}
		return "issue Orders, each one of: " + strings.Join(names, " / ")
	case "resource-action-menu":
		var actions []string
		for _, a := range getList(e, "actions") {
			am, _ := asMap(a)
			actions = append(actions, describeMenuAction(am, ctx))
		}
		return "actions may be performed when their conditions are met: " + strings.Join(actions, " / ")
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
			if m["model_relation"] == "engaged-with-target" {
				where = "this unit that is within Engagement Range of the target unit"
			} else if m["per_model"] == "target" {
				where = "the target unit"
			}
			return "roll one " + die + " for each model in " + where + ": for each " + hit + ", " + subjMW + " " + verb + " " + per + " " + perNoun
		}
		return "roll " + die + ": for each " + hit + ", " + subjMW + " " + verb + " " + per + " " + perNoun
	}
	// Escalating table ("on a 2-3, 1 mortal wound; on a 4-5, D3 ..."): the
	// roll decides the amount, so render the rows, not "a number of".
	tableAny := m["amount_table"]
	if tableAny == nil {
		tableAny = m["table"]
	}
	if table, ok := tableAny.([]any); ok && len(table) > 0 {
		var rows []string
		for i, rAny := range table {
			r, _ := asMap(rAny)
			amt := diceCase(r["amount"])
			noun := "mortal wounds"
			if amt == "1" {
				noun = "mortal wound"
			}
			if i == 0 {
				rows = append(rows, "on a "+ejstr(r["roll"])+", "+subjMW+" "+verb+" "+amt+" "+noun)
			} else {
				rows = append(rows, "on a "+ejstr(r["roll"])+", "+amt+" "+noun)
			}
		}
		die := "D6"
		if m["dice"] != nil {
			die = diceCase(m["dice"])
		}
		return "roll one " + die + ": " + strings.Join(rows, "; ")
	}
	var a *string
	switch {
	case m["bind_count_as"] != nil || m["count_from"] != nil:
		s := "that many"
		a = &s
	case m["count"] != nil:
		s := ejstr(m["count"])
		a = &s
	case m["amount"] != nil:
		s := ejstr(m["amount"])
		a = &s
	case m["dice"] != nil:
		s := diceCase(m["dice"])
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
	if test, ok := getMap(e, "test"); ok && test != nil {
		who := "that unit"
		if test["subject"] == "self" {
			who = "this model"
		}
		success := "nothing happens"
		if effect, ok := getMap(e, "on_success"); ok && effect != nil {
			success = describeEffectInline(effect, ctx)
		}
		fail := ""
		if effect, ok := getMap(e, "on_fail"); ok && effect != nil {
			fail = "; otherwise, " + describeEffectInline(effect, ctx)
		}
		return who + " takes a Leadership test (2D6, passing on its current Leadership or higher); if passed, " + success + fail
	}
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
func diceTableResultLabel(values []any) string {
	results := make([]int, 0, len(values))
	for _, value := range values {
		if number, ok := parseNumber(value); ok {
			results = append(results, int(number))
		}
	}
	sort.Ints(results)
	if len(results) == 0 {
		return ""
	}
	if len(results) == 1 {
		return strconv.Itoa(results[0])
	}
	return strconv.Itoa(results[0]) + "-" + strconv.Itoa(results[len(results)-1])
}

func describeDiceTableInline(e map[string]any, ctx map[string]any) string {
	var outcomes []string
	for _, outcomeAny := range getList(e, "outcomes") {
		outcome, _ := asMap(outcomeAny)
		label := diceTableResultLabel(getList(outcome, "results"))
		effect, _ := getMap(outcome, "effect")
		outcomes = append(outcomes, "on a "+label+", "+describeEffectInline(effect, ctx))
	}
	return "roll one " + diceCase(e["dice"]) + ": " + strings.Join(outcomes, "; ")
}

// describeRequirement renders a dice-pool option requirement. A single
// requirement is "<type> of <min_value>+"; an `any_of` alternative joins the
// member phrases with " or ". Mirror of describeRequirement in
// tools/src/translate/effect.ts.
func describeRequirement(req map[string]any) string {
	one := func(r map[string]any) string {
		return ejstr(r["type"]) + " of " + ejstr(r["min_value"]) + "+"
	}
	if anyOf, ok := asList(req["any_of"]); ok {
		parts := make([]string, len(anyOf))
		for i, r := range anyOf {
			rm, _ := asMap(r)
			parts[i] = one(rm)
		}
		return strings.Join(parts, " or ")
	}
	return one(req)
}

func describeDicePoolInline(e map[string]any, ctx map[string]any) string {
	poolText := "your dice pool"
	if pool, ok := getMap(e, "pool"); ok && pool != nil {
		poolText = ejstr(pool["count"]) + ejstr(pool["die"])
	}
	var opts []string
	for _, o := range getList(e, "options") {
		om, _ := asMap(o)
		req, _ := getMap(om, "requirement")
		eff, _ := getMap(om, "effect")
		opts = append(opts, ejstr(om["name"])+" (requires "+describeRequirement(req)+"): "+describeEffectInline(eff, ctx))
	}
	return "roll " + poolText + ": " + strings.Join(opts, " / ")
}

// sequenceBoundDicePrefix hoists an implicit dice roll shared across a
// sequence: when an early step's modifier declares `bind_count_as` (a
// producer whose rolled count a later step reuses via `count_from`, both
// local to this sequence), the roll itself renders once as a lead clause
// ("roll one D3: ") instead of being repeated or re-rolled by each
// referencing step, which instead renders "that many".
func sequenceBoundDicePrefix(steps []any) string {
	for _, s := range steps {
		sm, ok := asMap(s)
		if !ok {
			continue
		}
		m := mod(sm)
		if m["bind_count_as"] == nil {
			continue
		}
		dice := m["count"]
		if dice == nil {
			dice = m["dice"]
		}
		if dice == nil {
			continue
		}
		return "roll one " + diceCase(dice) + ": "
	}
	return ""
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
		if inner != nil && getStr(inner, "type") == "named-region-state" {
			modifier, _ := asMap(inner["modifier"])
			text := capitalize(describeNamedRegionConditional(modifier, cond, ctx))
			if strings.HasSuffix(text, ".") {
				return indent + arrow + text
			}
			return indent + arrow + text + "."
		}
		if inner != nil && containerTypes[getStr(inner, "type")] {
			return indent + capitalize(conditionLeadIn(cond)) + ":\n" + describeEffect(inner, depth+1, ctx)
		}
		return indent + arrow + capitalize(conditionLeadIn(cond)) + ", " + describeEffectInline(inner, ctx) + "."
	case "rules-bundle", "sequence":
		steps := getList(e, "steps")
		var parts []string
		for _, s := range steps {
			sm, _ := asMap(s)
			parts = append(parts, describeEffect(sm, depth, ctx))
		}
		joined := strings.Join(parts, "\n")
		if prefix := sequenceBoundDicePrefix(steps); prefix != "" {
			return indent + arrow + capitalize(strings.TrimSpace(prefix)) + "\n" + joined
		}
		return joined
	case "named-effect":
		level := ""
		if e["kind"] == "psychic" && e["level"] != nil {
			level = " (Psychic level " + ejstr(e["level"]) + ")"
		}
		inner, _ := getMap(e, "effect")
		prefix := ""
		if e["optional"] == true {
			prefix = "You can use "
		}
		name := prefix + ejstr(e["name"]) + level
		if inner != nil && containerTypes[getStr(inner, "type")] {
			return indent + name + ":\n" + describeEffect(inner, depth+1, ctx)
		}
		return indent + arrow + name + ": " + capitalize(describeEffectInline(inner, ctx)) + "."
	case "choice":
		prompt, _ := e["choice_prompt"].(string)
		if prompt == "" {
			label := ""
			if cl, ok := e["choice_label"].(string); ok && cl != "" {
				label = " (" + titleCase(cl) + ")"
			}
			prompt = "select one of the following" + label
		}
		var opts []string
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			opts = append(opts, indent+"  - "+capitalize(describeEffectInline(om, ctx))+".")
		}
		return indent + capitalize(prompt) + ":\n" + strings.Join(opts, "\n")
	case "dice-gated":
		return indent + arrow + capitalize(describeDiceGatedInline(e, ctx)) + "."
	case "dice-table":
		lines := []string{indent + arrow + "Roll one " + diceCase(e["dice"]) + ":"}
		for _, outcomeAny := range getList(e, "outcomes") {
			outcome, _ := asMap(outcomeAny)
			label := diceTableResultLabel(getList(outcome, "results"))
			outcomeEffect, _ := getMap(outcome, "effect")
			lines = append(lines, indent+"  - On "+label+": "+capitalize(describeEffectInline(outcomeEffect, ctx))+".")
		}
		return strings.Join(lines, "\n")
	case "dice-pool-allocation":
		poolText := "your dice pool"
		if pool, ok := getMap(e, "pool"); ok && pool != nil {
			poolText = ejstr(pool["count"]) + ejstr(pool["die"])
		}
		upTo := " to activate the following"
		if e["max_activations"] != nil {
			upTo = " to activate up to " + ejstr(e["max_activations"]) + " of the following"
		}
		lines := []string{indent + arrow + "Roll " + poolText + "; allocate dice" + upTo + ":"}
		for _, optAny := range getList(e, "options") {
			opt, _ := asMap(optAny)
			req, _ := getMap(opt, "requirement")
			eff, _ := getMap(opt, "effect")
			lines = append(lines, indent+"  - "+ejstr(opt["name"])+" (requires "+describeRequirement(req)+"): "+describeEffectInline(eff, ctx)+".")
		}
		return strings.Join(lines, "\n")
	case "select-units":
		sel, _ := getMap(e, "selector")
		inner, _ := getMap(e, "effect")
		innerCtx := selectUnitsCtx(ctx, sel)
		engagement := selectUnitsEngagement(sel)
		lead := "Select " + selectUnitsSubject(sel)
		header := indent + arrow + lead
		if engagement != "" {
			header += ". " + engagement
		}
		if inner != nil && containerTypes[getStr(inner, "type")] {
			if selectUnitsPlural(sel) {
				noun := "unit"
				if sel["target_kind"] == "model" {
					noun = "model"
				}
				return strings.TrimSuffix(header, ".") + ":\n" + indent + "  -> For each selected " + noun + ":\n" + describeEffect(inner, depth+2, innerCtx)
			}
			return strings.TrimSuffix(header, ".") + ":\n" + describeEffect(inner, depth+1, innerCtx)
		}
		nested := selectedRecipient(describeEffectInline(inner, innerCtx), sel)
		if engagement != "" {
			return header + " " + capitalize(nested) + "."
		}
		return header + ": " + nested + "."
	case "leader-model-ability-grant":
		return indent + arrow + capitalize(leaderModelAbilityGrantClause(e, ctx)) + "."
	case "persistent-designation":
		if !persistentDesignationSupported(e) {
			return indent + arrow + "[persistent-designation]."
		}
		consumer, _ := getMap(e, "consumer")
		inner, _ := getMap(consumer, "effect")
		head := indent + arrow + capitalize(persistentDesignationLead(e)) + " " + persistentDesignationWhen(e)
		if inner != nil && containerTypes[getStr(inner, "type")] {
			return head + ":\n" + describeEffect(inner, depth+1, ctx)
		}
		return head + ", " + describeEffectInline(inner, ctx) + "."
	case "for-each-unit":
		sel, _ := getMap(e, "selector")
		inner, _ := getMap(e, "effect")
		innerCtx := forEachUnitCtx(ctx, sel)
		lead := "For each " + forEachUnitSubject(sel)
		if inner != nil && containerTypes[getStr(inner, "type")] {
			return indent + lead + ":\n" + describeEffect(inner, depth+1, innerCtx)
		}
		return indent + lead + ": " + capitalize(describeEffectInline(inner, innerCtx)) + "."
	case "designate-target":
		sel, _ := asMap(e["select"])
		desig := ""
		if truthy(e["designation"]) {
			desig = designationLabel(e["designation"])
		}
		// The mark's timing and duration are content: "After this unit shoots,
		// select …. Until your next Command phase, each time …".
		selectLead := "Select"
		if truthy(sel["timing"]) {
			selectLead = capitalize(describeTiming(sel["timing"])) + ", select"
		}
		_, durTrail := durationClauses(e["duration"])
		applies, _ := getMap(e, "applies")
		inner, _ := getMap(applies, "effect")
		when := "each time a friendly unit makes an attack against it"
		if keywords := getStrList(applies, "attacker_keywords"); len(keywords) > 0 {
			when = "each time a friendly " + strings.Join(keywords, " ") + " model makes an attack against it"
		}
		if applies["to"] == "target" {
			when = "while it is your target"
		} else if applies["to"] == "bearer-attacks-target" {
			when = "each time this unit makes an attack against it"
		}
		whenClause := capitalize(when)
		if durTrail != "" {
			whenClause = capitalize(durTrail) + ", " + when
		}
		head := indent + arrow + selectLead + " one " + designationTargetSubject(sel) + desig + ". " + whenClause
		if inner != nil && containerTypes[getStr(inner, "type")] {
			return head + ":\n" + describeEffect(inner, depth+1, ctx)
		}
		return head + ", " + describeEffectInline(inner, ctx) + "."
	case "stance-select":
		when := "At the start of your turn"
		if s, ok := e["select"].(string); ok {
			when = capitalize(eventClause(s))
		}
		consum := ""
		if e["mode"] == "consumable" {
			consum = " (each may be chosen once per battle)"
		}
		lines := []string{indent + arrow + when + ", select one" + consum + ":"}
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			oe, _ := getMap(om, "effect")
			lines = append(lines, indent+"  - "+ejstr(om["name"])+": "+describeEffectInline(oe, ctx)+".")
		}
		return strings.Join(lines, "\n")
	case "risk-reward":
		risk, _ := getMap(e, "risk")
		onFail := "there is a consequence"
		if rf, ok := getMap(risk, "on_fail"); ok && rf != nil {
			onFail = describeEffectInline(rf, ctx)
		}
		reward, _ := getMap(e, "reward")
		return indent + arrow + "First take a " + testName(risk["test"]) + " test — on a failure, " + onFail + "; then " + describeEffectInline(reward, ctx) + "."
	case "issue-orders":
		n := "one or more"
		if e["count"] != nil {
			n = ejstr(e["count"])
		}
		rng := ""
		if e["range"] != nil {
			rng = " within " + ejstr(e["range"]) + "\""
		}
		elig := ""
		if eg, ok := getMap(e, "eligible"); ok && truthy(eg["keyword"]) {
			elig = " " + ejstr(eg["keyword"])
		}
		lines := []string{indent + arrow + "Issue up to " + n + " Orders to eligible friendly" + elig + " units" + rng + ", each one of:"}
		for _, o := range getList(e, "options") {
			om, _ := asMap(o)
			oe, _ := getMap(om, "effect")
			lines = append(lines, indent+"  - "+ejstr(om["name"])+": "+describeEffectInline(oe, ctx)+".")
		}
		return strings.Join(lines, "\n")
	case "resource-action-menu":
		su, _ := getMap(e, "shared_usage")
		suClause := sharedUsageClause(su)
		intro := "Actions may be performed when their conditions are met"
		if suClause != "" {
			intro = "Actions may be performed when their conditions are met. " + capitalize(suClause)
		}
		lines := []string{indent + arrow + intro + ":"}
		for _, a := range getList(e, "actions") {
			am, _ := asMap(a)
			lines = append(lines, indent+"  - "+describeMenuAction(am, ctx))
		}
		return strings.Join(lines, "\n")
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
	case "once-per-battle-round":
		base = "once per battle round"
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
var moveWordRe = regexp.MustCompile(`\bmove\b`)

func describeReactiveTrigger(t map[string]any) string {
	s := eventClause(t["event"])
	if t["subject"] == "friendly-unit" {
		s = strings.Replace(s, "the unit", "a friendly unit", 1)
	}
	if t["subject"] == "enemy-unit" {
		s = strings.Replace(s, "the unit", "an enemy unit", 1)
	}
	if t["event"] == "stratagem-targeted" {
		s = "when this model's unit is targeted with a Stratagem"
	}
	if source, ok := getMap(t, "source_ability"); t["event"] == "ability-target-selected" && ok && source != nil {
		selected := "a unit"
		if t["subject"] == "friendly-unit" {
			selected = "a friendly unit"
		} else if t["subject"] == "enemy-unit" {
			selected = "an enemy unit"
		}
		s = "when " + selected + " is selected by the " + titleCase(ejstr(source["ability_id"])) + " ability of a " + ejstr(source["owner"]) + " " + strings.Join(getStrList(source, "keywords"), " ") + " unit"
	}
	if ejstr(t["event"]) == "falls-back" && ejstr(t["subject"]) == "enemy-unit" {
		s = "an enemy unit Falls Back"
	}
	// Narrow a move event to its move kinds: "ends a move" -> "ends a Normal,
	// Advance or Fall Back move".
	if mts := getStrList(t, "move_types"); len(mts) > 0 {
		kinds := make([]string, len(mts))
		for i, mt := range mts {
			if mt == "fall-back" {
				kinds[i] = "Fall Back"
			} else {
				kinds[i] = capWord(mt)
			}
		}
		repl := orList(kinds) + " move"
		if loc := moveWordRe.FindStringIndex(s); loc != nil {
			s = s[:loc[0]] + repl + s[loc[1]:]
		}
	}
	if prox, _ := getMap(t, "proximity"); prox != nil && prox["range"] != nil {
		of := "this unit"
		switch prox["of"] {
		case "bearer-unit":
			of = "this model's unit"
		case "attached-unit":
			of = "the unit this model leads"
		case "self", "bearer":
			of = "this model"
		}
		s += " within " + ejstr(prox["range"]) + "\" of " + of
	}
	if isEndOfPhaseDisembarkBattleShock(t) {
		s += ", if the unit disembarked from a Transport this turn and is Battle-shocked"
	} else if t["condition"] != nil {
		cond, _ := asMap(t["condition"])
		s += ", if " + describeCondition(cond)
	}
	if t["optional"] == true {
		s += ", you may use this ability"
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

// normalizeTriggers flattens the polymorphic trigger field (one object, an
// array, or nil) to a flat list of trigger maps (the ability fires on ANY).
func normalizeTriggers(t any) []map[string]any {
	if t == nil {
		return nil
	}
	if list, ok := asList(t); ok {
		out := make([]map[string]any, 0, len(list))
		for _, e := range list {
			if m, ok := asMap(e); ok {
				out = append(out, m)
			}
		}
		return out
	}
	if m, ok := asMap(t); ok {
		return []map[string]any{m}
	}
	return nil
}

// timingOfCondition returns the timing value of a bare `timing-is` condition,
// and whether the condition is of that type.
func timingOfCondition(c map[string]any) (string, bool) {
	if c != nil && c["type"] == "timing-is" {
		p, _ := getMap(c, "parameters")
		return ejstr(p["timing"]), true
	}
	return "", false
}

// conditionWithinRange returns the numeric range of a top-level within-range
// condition, and whether one is present.
func conditionWithinRange(c map[string]any) (float64, bool) {
	if c == nil {
		return 0, false
	}
	if c["type"] != "unit-within-range-of" && c["type"] != "opponent-unit-within-range" {
		return 0, false
	}
	p, _ := getMap(c, "parameters")
	rng := p["range"]
	if rng == nil {
		rng = p["range_inches"]
	}
	if rng == nil {
		rng = p["within_inches"]
	}
	return num(rng)
}

func renderTopLevel(e map[string]any, scope map[string]any, usage map[string]any, trigger any) string {
	ctx := map[string]any{
		"range_inches":     auraRadius(scope),
		"engagement_range": scope["range"] == "engagement-range",
		"scope_range":      scope["range"],
	}
	durLead, trail := durationClauses(scope["duration"])
	// An explicit usage limit supersedes the duration's coarse "once per battle" lead.
	lead := durLead
	if usage != nil && usage["frequency"] != nil {
		lead = usageClause(usage)
	}
	// A reactive trigger (or several — the ability fires on any) opens the
	// sentence ("Each time …"). B2: when a trigger's proximity just restates a
	// within-range condition on the effect, render the range once (drop it here).
	var triggers []map[string]any
	triggerEvents := map[string]bool{}
	for _, t := range normalizeTriggers(trigger) {
		if t["event"] != nil {
			triggers = append(triggers, t)
			if ev, ok := t["event"].(string); ok {
				triggerEvents[ev] = true
			}
		}
	}
	var condForRange map[string]any
	if e["type"] == "conditional" {
		condForRange, _ = getMap(e, "condition")
	}
	condRange, hasCondRange := conditionWithinRange(condForRange)
	var trigParts []string
	for _, t := range triggers {
		tt := t
		if hasCondRange {
			if prox, _ := getMap(t, "proximity"); prox != nil {
				if pr, ok := num(prox["range"]); ok && pr == condRange {
					tt = cloneMap(t)
					delete(tt, "proximity")
				}
			}
		}
		if desc := describeReactiveTrigger(tt); desc != "" {
			trigParts = append(trigParts, desc)
		}
	}
	trig := strings.Join(trigParts, " or ")

	if e["type"] == "conditional" {
		inner, _ := getMap(e, "effect")
		cond, _ := getMap(e, "condition")
		if inner != nil && getStr(inner, "type") == "named-region-state" {
			modifier, _ := asMap(inner["modifier"])
			return describeNamedRegionConditional(modifier, cond, ctx)
		}
		// B1: drop the condition lead-in when it merely restates a trigger's timing
		// (e.g. trigger start-of-phase + condition timing-is start-of-phase).
		leadIn := conditionLeadIn(cond)
		if condTiming, isTiming := timingOfCondition(cond); isTiming && triggerEvents[condTiming] {
			leadIn = ""
		}
		if inner != nil && containerTypes[getStr(inner, "type")] {
			header := joinNonEmpty([]string{trig, lead, leadIn, trail}, ", ")
			return capitalize(header) + ":\n" + describeEffect(inner, 1, ctx)
		}
		return assembleSentence([]string{trig, lead, leadIn, trail, describeEffectInline(inner, ctx)})
	}
	if containerTypes[getStr(e, "type")] {
		// A designate-target carrying its own `duration` renders that duration
		// itself — repeating the scope duration in the head would double it.
		ownDuration := (getStr(e, "type") == "designate-target" || getStr(e, "type") == "persistent-designation") && e["duration"] != nil
		block := describeEffect(e, 0, ctx)
		duration := trail
		if ownDuration {
			duration = ""
		}
		head := joinNonEmpty([]string{trig, lead, duration}, ", ")
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
		core = renderTopLevel(eff, scope, usage, a["trigger"])
	}
	at, _ := getMap(a, "applies_to")
	applies := describeAppliesTo(at)
	return joinNonEmpty([]string{core, applies}, "\n")
}

func designationTargetSubject(sel map[string]any) string {
	return designationTargetSubjectBase(sel) + selectorEligibilityClause(sel)
}

// Compose independent weapon axes without widening the affected model set.
func weaponNoun(m map[string]any) string {
	kind, name, keyword := "", "", ""
	if truthy(m["weapon_type"]) {
		kind = ejstr(m["weapon_type"]) + " "
	}
	if truthy(m["weapon_name"]) {
		name = ejstr(m["weapon_name"]) + " "
	}
	if truthy(m["weapon_keyword"]) {
		keyword = " with [" + strings.ToUpper(ejstr(m["weapon_keyword"])) + "]"
	}
	return kind + name + "weapons" + keyword
}
func weaponHolder(target any, ctx map[string]any) string {
	if target == "self" || target == "bearer" {
		return "this model"
	}
	if ctx["selected_model"] == true {
		return "that model"
	}
	if target == "unit" || target == "attached-unit" {
		if ctx["selected_unit"] == true {
			return "models in that unit"
		}
		return "models in this unit"
	}
	return subject(target, ctx)
}
func weaponRollScope(m map[string]any) string {
	if m["weapon_type"] != nil || m["weapon_name"] != nil || m["weapon_keyword"] != nil {
		return " with " + weaponNoun(m)
	}
	if m["attack_type"] != nil && m["attack_type"] != "any" {
		return " for " + ejstr(m["attack_type"]) + " attacks"
	}
	return ""
}

func selectionFrequency(value any) string {
	if ejstr(value) == "1" {
		return "once"
	}
	return ejstr(value) + " times"
}
