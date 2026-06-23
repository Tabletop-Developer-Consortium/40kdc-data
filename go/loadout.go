package wh40kdc

import (
	"math"
	"sort"
)

// Wargear-loadout maths shared by every consumer of the dataset. Go mirror of
// python .../data/loadout.py.

// optionCap is the maximum number of models that may take an option in a unit
// of modelCount.
func optionCap(option map[string]any, modelCount int, models []any) int {
	c, _ := getMap(option, "model_constraint")
	if len(c) == 0 {
		return maxInt(0, modelCount)
	}
	var cap int
	switch {
	case truthy(c["any_number"]):
		cap = modelCount
	case truthy(c["per_n_models"]):
		per := asInt(c["per_n_models"])
		cap = int(math.Floor(float64(modelCount) / float64(per)))
	default:
		if c["max_count"] != nil {
			cap = asInt(c["max_count"])
		} else {
			cap = 1
		}
	}
	if c["max_count"] != nil {
		cap = minInt(cap, asInt(c["max_count"]))
	}
	// Eligible-model clamp: an option scoped to a named model profile can be taken
	// by no more models than exist of that profile — a lone champion caps the swap
	// at 1 even when per_n_models would allow more. A name with no matching row
	// leaves the cap unclamped.
	if name, ok := c["model_name"].(string); ok && name != "" && len(models) > 0 {
		if eligible, ok := eligibleModelCount(models, modelCount, name); ok {
			cap = minInt(cap, eligible)
		}
	}
	// A swap is per-model: at most one per model, so never more than modelCount —
	// a max_count larger than the current squad size must not drive a weapon
	// count negative.
	return maxInt(0, minInt(cap, modelCount))
}

// eligibleModelCount is how many models of profile name a unit of modelCount
// fields, per allocateModels; (0, false) when no row carries that name.
func eligibleModelCount(models []any, modelCount int, name string) (int, bool) {
	found := false
	for _, mAny := range models {
		if m, ok := asMap(mAny); ok {
			if n, _ := m["name"].(string); n == name {
				found = true
				break
			}
		}
	}
	if !found {
		return 0, false
	}
	n := 0
	for _, row := range allocateModels(models, modelCount) {
		if rn, _ := row.model["name"].(string); rn == name {
			n += row.count
		}
	}
	return n, true
}

func addedIDs(option map[string]any, choiceIndex int) []string {
	if r := getStrList(option, "replacement"); len(r) > 0 {
		return r
	}
	choices := getList(option, "replacement_choice")
	if choiceIndex >= 0 && choiceIndex < len(choices) {
		return toStrList(choices[choiceIndex])
	}
	return nil
}

func allReplacementIDs(options []any) map[string]struct{} {
	out := map[string]struct{}{}
	for _, oAny := range options {
		o, _ := asMap(oAny)
		for _, id := range getStrList(o, "replacement") {
			out[id] = struct{}{}
		}
		for _, group := range getList(o, "replacement_choice") {
			for _, id := range toStrList(group) {
				out[id] = struct{}{}
			}
		}
	}
	return out
}

// allReplacedIDs is every id that any option swaps OUT (the base weapon a swap
// replaces).
func allReplacedIDs(options []any) map[string]struct{} {
	out := map[string]struct{}{}
	for _, oAny := range options {
		o, _ := asMap(oAny)
		for _, id := range getStrList(o, "replaces") {
			out[id] = struct{}{}
		}
	}
	return out
}

// baseWeaponIDs is the derived base (always-carried) weapon ids — the fallback
// when a unit has no recorded default_weapon_ids. A weapon_id is base iff it is
// swapped out by some option (replaces) OR it never appears on any option's
// added side. The replaces clause is load-bearing: a base weapon can also be
// re-added inside another option's choice branch and is still base. An orphan
// weapon (in weapon_ids, touched by no option) stays base.
func baseWeaponIDs(unit map[string]any, options []any) []string {
	added := allReplacementIDs(options)
	replaced := allReplacedIDs(options)
	var out []string
	for _, id := range getStrList(unit, "weapon_ids") {
		_, isAdded := added[id]
		_, isReplaced := replaced[id]
		if isReplaced || !isAdded {
			out = append(out, id)
		}
	}
	return out
}

// hasRecordedDefaults is true when every model row records a non-empty default
// loadout.
func hasRecordedDefaults(models []any) bool {
	if len(models) == 0 {
		return false
	}
	for _, mAny := range models {
		m, _ := asMap(mAny)
		if len(getStrList(m, "default_weapon_ids")) == 0 {
			return false
		}
	}
	return true
}

// allocatedModel pairs a composition model row with its allocated count.
type allocatedModel struct {
	model map[string]any
	count int
}

// allocateModels allocates modelCount models across the composition's
// model-types: each leader is taken at its min (in declared order, never
// exceeding the remaining count), then the non-leader "bulk" types absorb the
// rest — each its min first, then any leftover to the bulk type with the
// largest max. If there is no non-leader type, the leaders are the sink.
// Deterministic; pinned by the conformance corpus.
func allocateModels(models []any, modelCount int) []*allocatedModel {
	out := make([]*allocatedModel, 0, len(models))
	for _, mAny := range models {
		m, _ := asMap(mAny)
		out = append(out, &allocatedModel{model: m, count: 0})
	}
	remaining := maxInt(0, modelCount)
	// Leaders first, at their declared minimum.
	for _, row := range out {
		if !truthy(row.model["is_leader_model"]) {
			continue
		}
		c := minInt(asInt(row.model["min"]), remaining)
		row.count += c
		remaining -= c
	}
	bulk := make([]*allocatedModel, 0, len(out))
	for _, row := range out {
		if !truthy(row.model["is_leader_model"]) {
			bulk = append(bulk, row)
		}
	}
	if len(bulk) == 0 {
		// No non-leader type: pour any remainder onto the leaders.
		bulk = append(bulk, out...)
	}
	// Each bulk type takes its min, then the remainder lands on the largest-max type.
	for _, row := range bulk {
		c := minInt(asInt(row.model["min"]), remaining)
		row.count += c
		remaining -= c
	}
	if remaining > 0 && len(bulk) > 0 {
		sink := bulk[0]
		for _, row := range bulk[1:] {
			if asInt(row.model["max"]) > asInt(sink.model["max"]) {
				sink = row
			}
		}
		sink.count += remaining
	}
	return out
}

// baseCounts is the base loadout counts: id -> count across the unit with no
// swaps applied. When the composition records per-model default_weapon_ids,
// those are authoritative — base = sum over model-types of (allocated count ×
// default weapons). Otherwise it falls back to baseWeaponIDs × modelCount.
func baseCounts(unit map[string]any, modelCount int, options []any, models []any) map[string]int {
	counts := map[string]int{}
	if hasRecordedDefaults(models) {
		for _, row := range allocateModels(models, modelCount) {
			if row.count == 0 {
				continue
			}
			for _, id := range getStrList(row.model, "default_weapon_ids") {
				counts[id] += row.count
			}
		}
		return counts
	}
	for _, id := range baseWeaponIDs(unit, options) {
		counts[id] += modelCount
	}
	return counts
}

// baseLoadout is the base (legal, no-swap) loadout: id -> count, every base
// weapon on every model. The legal default a freshly-added unit ships with —
// each model in its out-of-the-box configuration. maximalLoadout starts from
// this set and then applies every option at full cap.
func baseLoadout(unit map[string]any, modelCount int, options []any, models []any) map[string]int {
	return baseCounts(unit, modelCount, options, models)
}

// maximalLoadout is the maximal (take-every-swap) loadout: id -> count.
func maximalLoadout(unit map[string]any, modelCount int, options []any, models []any) map[string]int {
	counts := baseCounts(unit, modelCount, options, models)
	for _, oAny := range options {
		o, _ := asMap(oAny)
		cap := optionCap(o, modelCount, models)
		if cap == 0 {
			continue
		}
		for _, id := range getStrList(o, "replaces") {
			counts[id] -= cap
		}
		for _, id := range addedIDs(o, 0) {
			counts[id] += cap
		}
	}
	clampFlatBudgets(unit, counts)
	for id, n := range counts {
		if n == 0 {
			delete(counts, id)
		}
	}
	return counts
}

func toMultiset(ids []string) map[string]int {
	m := map[string]int{}
	for _, id := range ids {
		m[id]++
	}
	return m
}

// sortedGroupWeapons renders a group's per-model weapons in a stable,
// language-agnostic order (by id) for cross-impl parity.
func sortedGroupWeapons(m map[string]int) []any {
	ids := make([]string, 0, len(m))
	for id, c := range m {
		if c > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	out := make([]any, 0, len(ids))
	for _, id := range ids {
		out = append(out, map[string]any{"id": id, "count": m[id]})
	}
	return out
}

func optionBundles(option map[string]any) [][]string {
	if r := getStrList(option, "replacement"); len(r) > 0 {
		return [][]string{r}
	}
	var out [][]string
	for _, group := range getList(option, "replacement_choice") {
		out = append(out, toStrList(group))
	}
	return out
}

// assignRowCounts assigns each composition row a model count summing to
// modelCount. Rows seed at min; a row with a distinctive default weapon (one
// carried by no other row) present in counts grows toward that weapon's implied
// count (recovers opt-in weapon-variant rows at min: 0); the leftover budget pours
// into the bulk row. Deterministic. Mirror of the TS assignRowCounts.
func assignRowCounts(models []any, modelCount int, counts map[string]int) []int {
	rowDefaults := make([]map[string]int, len(models))
	rowsWith := map[string]int{}
	for i, mAny := range models {
		m, _ := asMap(mAny)
		rowDefaults[i] = toMultiset(getStrList(m, "default_weapon_ids"))
		for id := range rowDefaults[i] {
			rowsWith[id]++
		}
	}
	modelAt := func(i int) map[string]any { m, _ := asMap(models[i]); return m }
	minOf := func(i int) int { return maxInt(0, asInt(modelAt(i)["min"])) }
	maxOf := func(i int) int { return maxInt(minOf(i), asInt(modelAt(i)["max"])) }

	out := make([]int, len(models))
	total := 0
	for i := range models {
		out[i] = minOf(i)
		total += out[i]
	}
	budget := maxInt(0, modelCount-total)
	if total > modelCount {
		over := total - modelCount
		for i := len(out) - 1; i >= 0 && over > 0; i-- {
			cut := minInt(over, out[i])
			out[i] -= cut
			over -= cut
		}
		budget = 0
	}

	distinctive := make([]bool, len(models))
	for i := range models {
		if budget == 0 {
			break
		}
		cap := -1
		saw := false
		for id, mult := range rowDefaults[i] {
			if rowsWith[id] == 1 && mult > 0 && counts[id] > 0 {
				saw = true
				v := counts[id] / mult
				if cap < 0 || v < cap {
					cap = v
				}
			}
		}
		if !saw {
			continue
		}
		distinctive[i] = true
		add := maxInt(0, minInt(minInt(cap, maxOf(i))-out[i], budget))
		out[i] += add
		budget -= add
	}

	headroom := func(i int) int { return maxOf(i) - out[i] }
	for budget > 0 {
		pick := -1
		for i := range models {
			if headroom(i) <= 0 || truthy(modelAt(i)["is_leader_model"]) || distinctive[i] {
				continue
			}
			if pick < 0 || headroom(i) > headroom(pick) {
				pick = i
			}
		}
		if pick < 0 {
			for i := range models {
				if headroom(i) <= 0 {
					continue
				}
				if pick < 0 || headroom(i) > headroom(pick) {
					pick = i
				}
			}
		}
		if pick < 0 {
			break
		}
		add := minInt(budget, headroom(pick))
		out[pick] += add
		budget -= add
	}
	return out
}

type mutGroup struct {
	modelName any
	count     int
	weapons   map[string]int
}

func groupHolds(g *mutGroup, replaces []string) bool {
	if g.count <= 0 {
		return false
	}
	for _, id := range replaces {
		if g.weapons[id] < 1 {
			return false
		}
	}
	return true
}

func findSource(groups []*mutGroup, scopedName any, replaces []string) int {
	if name, ok := scopedName.(string); ok {
		for i, g := range groups {
			if groupHolds(g, replaces) {
				if gn, _ := g.modelName.(string); gn == name {
					return i
				}
			}
		}
		for i, g := range groups {
			if groupHolds(g, replaces) {
				return i
			}
		}
		return -1
	}
	for i, g := range groups {
		if groupHolds(g, replaces) {
			return i
		}
	}
	return -1
}

// applySwaps explains leftover weapon counts as option swaps, peeling a variant
// sub-group off the base group of the model-type each option is scoped to. Mirror
// of the TS applySwaps.
func applySwaps(groups *[]*mutGroup, models []any, options []any, modelCount int, remaining map[string]int) {
	for _, oAny := range options {
		o, _ := asMap(oAny)
		capN := optionCap(o, modelCount, models)
		if capN <= 0 {
			continue
		}
		replaces := getStrList(o, "replaces")
		var scopedName any
		if c, ok := getMap(o, "model_constraint"); ok {
			scopedName = c["model_name"]
		}
		for _, bundle := range optionBundles(o) {
			if len(bundle) == 0 {
				continue
			}
			addM := toMultiset(bundle)
			k := capN
			for id, mult := range addM {
				avail := remaining[id]
				if avail < 0 {
					avail = 0
				}
				k = minInt(k, avail/mult)
			}
			if k <= 0 {
				continue
			}
			idx := findSource(*groups, scopedName, replaces)
			if idx < 0 {
				continue
			}
			take := minInt(k, (*groups)[idx].count)
			if take <= 0 {
				continue
			}
			w := map[string]int{}
			for id, c := range (*groups)[idx].weapons {
				w[id] = c
			}
			for _, id := range replaces {
				w[id]--
			}
			for id, mult := range addM {
				w[id] += mult
			}
			for id, c := range w {
				if c <= 0 {
					delete(w, id)
				}
			}
			(*groups)[idx].count -= take
			*groups = append(*groups, &mutGroup{modelName: (*groups)[idx].modelName, count: take, weapons: w})
			for id, mult := range addM {
				remaining[id] -= mult * take
			}
			for _, id := range replaces {
				remaining[id] += take
			}
		}
	}
}

// GroupLoadout decomposes a unit's flat loadout into per-model-type groups,
// reusing allocateModels's partition and per-model-type option scoping. Returns
// nil when the decomposition is not exact (single model, no recorded per-model
// defaults, or leftover counts no swap explains) so callers omit loadout_groups
// and renderers keep their unit-wide rendering. Mirror of the TS groupLoadout.
func GroupLoadout(unit map[string]any, modelCount int, options []any, models []any, counts map[string]int) []any {
	if modelCount <= 1 || !hasRecordedDefaults(models) {
		return nil
	}
	remaining := map[string]int{}
	for id, c := range counts {
		if c > 0 {
			remaining[id] = c
		}
	}
	rowN := assignRowCounts(models, modelCount, remaining)
	groups := []*mutGroup{}
	for i, mAny := range models {
		k := rowN[i]
		if k == 0 {
			continue
		}
		m, _ := asMap(mAny)
		def := toMultiset(getStrList(m, "default_weapon_ids"))
		for id, c := range def {
			remaining[id] -= c * k
		}
		weapons := map[string]int{}
		for id, c := range def {
			weapons[id] = c
		}
		groups = append(groups, &mutGroup{modelName: m["name"], count: k, weapons: weapons})
	}
	applySwaps(&groups, models, options, modelCount, remaining)
	for _, c := range remaining {
		if c != 0 {
			return nil
		}
	}
	out := []any{}
	for _, g := range groups {
		if g.count <= 0 {
			continue
		}
		out = append(out, map[string]any{
			"model_name": g.modelName,
			"count":      g.count,
			"weapons":    sortedGroupWeapons(g.weapons),
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// clampFlatBudgets caps each weapon's count by any single-weapon flat
// wargear_budgets entry (a "this model takes at most N of weapon X" line,
// modelled as items of length 1 with per_models == 0). A weapon reachable
// through several swap slots — e.g. a Knight Destrier whose chastiser gatling
// cannon AND frag bombard can each be swapped for a bellatus reaper chainsword —
// would otherwise sum to an illegal count; clamping here makes maximalLoadout/
// weaponBounds agree with the same invalid-loadout prevention the editor
// enforces. Shared (multi-item) and ratio (per_models > 0) budgets stay policed
// by budgetViolations.
func clampFlatBudgets(unit map[string]any, counts map[string]int) {
	for _, bAny := range getList(unit, "wargear_budgets") {
		budget, _ := asMap(bAny)
		items := getStrList(budget, "items")
		if len(items) != 1 || asInt(budget["per_models"]) != 0 {
			continue
		}
		capN := asInt(budget["count"])
		if cur, ok := counts[items[0]]; ok && cur > capN {
			counts[items[0]] = capN
		}
	}
}

type intRange struct{ min, max int }

func weaponBounds(unit map[string]any, modelCount int, options []any, models []any) map[string]intRange {
	bounds := map[string]intRange{}
	for id, count := range baseCounts(unit, modelCount, options, models) {
		bounds[id] = intRange{count, count}
	}
	for _, oAny := range options {
		o, _ := asMap(oAny)
		cap := optionCap(o, modelCount, models)
		for _, id := range getStrList(o, "replaces") {
			b := bounds[id]
			bounds[id] = intRange{maxInt(0, b.min-cap), b.max}
		}
		adds := map[string]struct{}{}
		for _, id := range getStrList(o, "replacement") {
			adds[id] = struct{}{}
		}
		for _, group := range getList(o, "replacement_choice") {
			for _, id := range toStrList(group) {
				adds[id] = struct{}{}
			}
		}
		for id := range adds {
			b := bounds[id]
			bounds[id] = intRange{b.min, b.max + cap}
		}
	}
	// A single-weapon flat budget caps the weapon's ceiling regardless of how
	// many swap slots can add it (see clampFlatBudgets), so an editor/salvo input
	// clamped against these bounds can never reach an over-cap, illegal count.
	for _, bAny := range getList(unit, "wargear_budgets") {
		budget, _ := asMap(bAny)
		items := getStrList(budget, "items")
		if len(items) != 1 || asInt(budget["per_models"]) != 0 {
			continue
		}
		capN := asInt(budget["count"])
		if b, ok := bounds[items[0]]; ok && b.max > capN {
			bounds[items[0]] = intRange{minInt(b.min, capN), capN}
		}
	}
	return bounds
}

func validateLoadout(unit map[string]any, modelCount int, options []any, counts map[string]int, models []any) []map[string]string {
	bounds := weaponBounds(unit, modelCount, options, models)
	var out []map[string]string
	// Items governed by a shared-allowance budget are policed solely by
	// budgetViolations; their per-id weaponBounds max is derived from the dump's
	// cross-product loadout branches (the unreliable signal the budget replaces),
	// so skip the per-id check for them.
	budgeted := map[string]struct{}{}
	for _, bAny := range getList(unit, "wargear_budgets") {
		b, _ := asMap(bAny)
		for _, id := range getStrList(b, "items") {
			budgeted[id] = struct{}{}
		}
	}
	for id, n := range counts {
		if _, isBudgeted := budgeted[id]; isBudgeted {
			continue
		}
		b, ok := bounds[id]
		if !ok {
			continue
		}
		if n > b.max {
			out = append(out, map[string]string{"id": id, "code": "exceeds-max", "message": id + ": " + itoa(n) + " exceeds max " + itoa(b.max)})
		} else if n < b.min {
			out = append(out, map[string]string{"id": id, "code": "below-min", "message": id + ": " + itoa(n) + " below min " + itoa(b.min)})
		}
	}
	out = append(out, swapConflicts(unit, modelCount, options, counts, models)...)
	out = append(out, budgetViolations(unit, modelCount, counts)...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i]["id"] != out[j]["id"] {
			return out[i]["id"] < out[j]["id"]
		}
		return out[i]["code"] < out[j]["code"]
	})
	return out
}

// swapConflicts reports swap-conservation violations the per-id weaponBounds
// can't see: a model's replaceable slot holds the base weapon OR one of its
// swap replacements, never both, so count(base) + sum(count(replacements))
// cannot exceed modelCount. Enforced only for the unambiguous shape — a base
// weapon swapped out by plain (non-choice) options that replace it alone, whose
// replacement ids are unique within this unit's option set and aren't
// themselves base weapons. Mirror of tools/src/data/loadout.ts.
func swapConflicts(unit map[string]any, modelCount int, options []any, counts map[string]int, models []any) []map[string]string {
	baseMap := baseCounts(unit, modelCount, options, models)
	baseIDs := map[string]struct{}{}
	for id := range baseMap {
		baseIDs[id] = struct{}{}
	}
	addedBy := map[string]int{}
	for _, oAny := range options {
		o, _ := asMap(oAny)
		for _, id := range getStrList(o, "replacement") {
			addedBy[id]++
		}
		for _, group := range getList(o, "replacement_choice") {
			for _, id := range toStrList(group) {
				addedBy[id]++
			}
		}
	}
	var out []map[string]string
	for base := range baseIDs {
		cleanAdds := map[string]struct{}{}
		messy := false
		for _, oAny := range options {
			o, _ := asMap(oAny)
			replaces := getStrList(o, "replaces")
			if !contains(replaces, base) {
				continue
			}
			if len(replaces) != 1 || len(getList(o, "replacement_choice")) > 0 {
				messy = true
				break
			}
			for _, b := range getStrList(o, "replacement") {
				if _, isBase := baseIDs[b]; isBase || addedBy[b] > 1 {
					messy = true
					break
				}
				cleanAdds[b] = struct{}{}
			}
			if messy {
				break
			}
		}
		if messy || len(cleanAdds) == 0 {
			continue
		}
		// The slot can hold at most as many weapons as there are models carrying
		// this base weapon by default — its base count (modelCount when not
		// per-model).
		cap, ok := baseMap[base]
		if !ok {
			cap = modelCount
		}
		total := counts[base]
		for b := range cleanAdds {
			total += counts[b]
		}
		if total > cap {
			out = append(out, map[string]string{
				"id":      base,
				"code":    "swap-conflict",
				"message": base + " and its swap replacement(s) total " + itoa(total) + ", exceeding " + itoa(cap) + " (a model takes the base weapon or a swap, not both)",
			})
		}
	}
	return out
}

// budgetViolations reports shared-allowance violations: each wargear_budgets
// entry lets its listed items take at most floor(modelCount * count / per_models)
// copies between them (per_models == 0 is a flat per-unit cap of count). The
// violation id is the budget's sorted items joined by "+". Mirror of the TS ref.
func budgetViolations(unit map[string]any, modelCount int, counts map[string]int) []map[string]string {
	var out []map[string]string
	for _, bAny := range getList(unit, "wargear_budgets") {
		budget, _ := asMap(bAny)
		items := getStrList(budget, "items")
		if len(items) == 0 {
			continue
		}
		used := 0
		for _, id := range items {
			used += counts[id]
		}
		count := asInt(budget["count"])
		perModels := asInt(budget["per_models"])
		var capN int
		var limit string
		if perModels > 0 {
			capN = int(math.Floor(float64(modelCount) * float64(count) / float64(perModels)))
			limit = itoa(count) + " per " + itoa(perModels) + " models"
		} else {
			capN = count
			limit = itoa(count) + " per unit"
		}
		if used > capN {
			sorted := append([]string(nil), items...)
			sort.Strings(sorted)
			id := joinStrings(sorted, "+")
			out = append(out, map[string]string{
				"id":      id,
				"code":    "exceeds-allowance",
				"message": id + ": " + itoa(used) + " exceeds shared allowance " + itoa(capN) + " (" + limit + ")",
			})
		}
	}
	return out
}

// tierModels merges a tier's per-model count ranges onto the composition's
// models metadata by name, producing the model list the loadout maths consume.
func tierModels(tier map[string]any, base []any) []any {
	byName := map[string]map[string]any{}
	for _, mAny := range base {
		if m, ok := asMap(mAny); ok {
			if n, _ := m["name"].(string); n != "" {
				byName[n] = m
			}
		}
	}
	var out []any
	for _, tmAny := range getList(tier, "models") {
		tm, _ := asMap(tmAny)
		name, _ := tm["name"].(string)
		merged := map[string]any{}
		if b, ok := byName[name]; ok {
			for k, v := range b {
				merged[k] = v
			}
		}
		merged["name"] = tm["name"]
		merged["min"] = tm["min"]
		merged["max"] = tm["max"]
		out = append(out, merged)
	}
	return out
}

// checkUnitLegality is whole-unit legality, tier-aware — the building block for a
// roster check. A roster records only the total modelCount, so select every tier
// whose total range [Σmin, Σmax] contains it and run validateLoadout against each
// tier's allocation; the unit is legal iff some containing tier validates clean.
// Deterministic reporting: the empty result of the first clean tier (in tier
// order), else the violations of the first containing tier; an
// invalid-model-count violation when the size matches no tier. With no tiers it
// falls back to a plain validateLoadout. Mirror of the TS reference.
func checkUnitLegality(unit map[string]any, modelCount int, options []any, counts map[string]int, models []any, tiers []any) []map[string]string {
	if len(tiers) == 0 {
		return validateLoadout(unit, modelCount, options, counts, models)
	}
	var candidates [][]any
	for _, tAny := range tiers {
		tier, _ := asMap(tAny)
		tm := tierModels(tier, models)
		lo, hi := 0, 0
		for _, mAny := range tm {
			m, _ := asMap(mAny)
			lo += asInt(m["min"])
			hi += asInt(m["max"])
		}
		if modelCount >= lo && modelCount <= hi {
			candidates = append(candidates, tm)
		}
	}
	if len(candidates) == 0 {
		uid, _ := unit["id"].(string)
		return []map[string]string{{
			"id":      uid,
			"code":    "invalid-model-count",
			"message": uid + ": " + itoa(modelCount) + " models matches no composition tier",
		}}
	}
	var first []map[string]string
	for _, tm := range candidates {
		violations := validateLoadout(unit, modelCount, options, counts, tm)
		if len(violations) == 0 {
			return []map[string]string{}
		}
		if first == nil {
			first = violations
		}
	}
	return first
}

func joinStrings(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}

func toStrList(v any) []string {
	l, _ := asList(v)
	out := make([]string, 0, len(l))
	for _, e := range l {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
