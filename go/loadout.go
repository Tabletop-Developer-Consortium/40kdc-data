package wh40kdc

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

// Wargear-loadout maths shared by every consumer of the dataset. Go mirror of
// python .../data/loadout.py.

// optionCap is the maximum number of TIMES an option may be taken in a unit of
// modelCount models: any_number alone → once per model; any_number WITH
// max_count: L → up to L per model (a multi-take mount: "up to 2 seeker
// missiles", "up to three of the following, and can take duplicates"); else
// per_n_models → floor(n / per), clamped by max_count when set; else
// max_count ?? 1 (a flat allowance). A null constraint is treated as
// unrestricted (every model). Never negative.
func optionCap(option map[string]any, modelCount int, models []any) int {
	c, _ := getMap(option, "model_constraint")
	if len(c) == 0 {
		return maxInt(0, modelCount)
	}
	// Per-model multiplicity: >1 only for the any_number+max_count multi-take
	// shape; every other shape takes an option at most once per model.
	perModel := 1
	if truthy(c["any_number"]) && c["max_count"] != nil {
		perModel = asInt(c["max_count"])
	}
	var cap int
	switch {
	case truthy(c["any_number"]):
		cap = modelCount * perModel
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
	if !truthy(c["any_number"]) && c["max_count"] != nil {
		cap = minInt(cap, asInt(c["max_count"]))
	}
	// Eligible-model clamp: an option scoped to a named model profile can be taken
	// by no more models than exist of that profile (× the per-model multiplicity) —
	// a lone champion caps the swap at 1 even when per_n_models would allow more. A
	// name with no matching row leaves the cap unclamped.
	if name, ok := c["model_name"].(string); ok && name != "" && len(models) > 0 {
		if eligible, ok := eligibleModelCount(models, modelCount, name); ok {
			cap = minInt(cap, eligible*perModel)
		}
	}
	// At most perModel takes per model, so never more than modelCount × perModel —
	// a flat max_count larger than the current squad size must not drive a swapped
	// weapon count negative.
	return maxInt(0, minInt(cap, modelCount*perModel))
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

// candidateRowCounts returns every bounded row allocation, with the historical
// heuristic first so established grouping output remains stable.
func candidateRowCounts(models []any, modelCount int, counts map[string]int) [][]int {
	preferred := assignRowCounts(models, modelCount, counts)
	mins := make([]int, len(models))
	maxs := make([]int, len(models))
	suffixMin := make([]int, len(models)+1)
	suffixMax := make([]int, len(models)+1)
	for i, modelAny := range models {
		model, _ := asMap(modelAny)
		mins[i] = maxInt(0, asInt(model["min"]))
		maxs[i] = maxInt(mins[i], asInt(model["max"]))
	}
	for i := len(models) - 1; i >= 0; i-- {
		suffixMin[i] = suffixMin[i+1] + mins[i]
		suffixMax[i] = suffixMax[i+1] + maxs[i]
	}

	var generated [][]int
	current := make([]int, len(models))
	var visit func(int, int)
	visit = func(i, remaining int) {
		if i == len(models) {
			if remaining == 0 {
				generated = append(generated, append([]int(nil), current...))
			}
			return
		}
		if remaining < suffixMin[i] || remaining > suffixMax[i] {
			return
		}
		lo := maxInt(mins[i], remaining-suffixMax[i+1])
		hi := minInt(maxs[i], remaining-suffixMin[i+1])
		for count := hi; count >= lo; count-- {
			current[i] = count
			visit(i+1, remaining-count)
		}
	}
	visit(0, maxInt(0, modelCount))

	seen := map[string]struct{}{}
	var out [][]int
	all := append([][]int{preferred}, generated...)
	for _, allocation := range all {
		total := 0
		parts := make([]string, len(allocation))
		for i, count := range allocation {
			total += count
			parts[i] = itoa(count)
		}
		key := strings.Join(parts, ",")
		if total != modelCount {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, allocation)
	}
	return out
}

// multisetKey is a stable key for a weapon multiset: "count:id" parts in id
// order, joined by "|"; zero/negative entries dropped. Mirror of TS multisetKey.
func multisetKey(m map[string]int) string {
	ids := make([]string, 0, len(m))
	for id, c := range m {
		if c > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.Itoa(m[id]) + ":" + id
	}
	return strings.Join(parts, "|")
}

// rowCandidate is one legal single-model loadout for a composition row: the
// weapons a model can carry plus the global option indices that produced it
// (each at most once), so the assignment search can charge per-option caps. key
// is multisetKey(weapons). Mirror of the TS RowCandidate.
type rowCandidate struct {
	weapons     map[string]int
	usedOptions []int
	key         string
}

type solverRow struct {
	name       any
	count      int
	candidates []rowCandidate
}

func joinInts(v []int) string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ",")
}

// enumerateRowCandidates enumerates every legal single-model loadout for one
// composition row. No-replacement additions may repeat up to their per-model
// max_count; swaps remain once per model. Caps are charged globally by search.
func enumerateRowCandidates(base map[string]int, rowName any, options []any) []rowCandidate {
	var applicable []int
	rowNameStr, rowNameOK := rowName.(string)
	for i, oAny := range options {
		o, _ := asMap(oAny)
		c, _ := getMap(o, "model_constraint")
		name, named := c["model_name"].(string)
		if !named || (rowNameOK && name == rowNameStr) {
			applicable = append(applicable, i)
		}
	}
	stateKey := func(w map[string]int, used []int) string {
		return multisetKey(w) + "#" + joinInts(used)
	}
	type qItem struct {
		weapons map[string]int
		used    []int
	}
	result := []rowCandidate{}
	seen := map[string]struct{}{stateKey(base, nil): {}}
	queue := []qItem{{weapons: cloneCounts(base)}}
	for head := 0; head < len(queue); head++ {
		cur := queue[head]
		result = append(result, rowCandidate{weapons: cur.weapons, usedOptions: cur.used, key: multisetKey(cur.weapons)})
		for _, oi := range applicable {
			o, _ := asMap(options[oi])
			replaces := getStrList(o, "replaces")
			uses := 0
			for _, used := range cur.used {
				if used == oi {
					uses++
				}
			}
			perModelLimit := 1
			if len(replaces) == 0 {
				if c, ok := getMap(o, "model_constraint"); ok && c["max_count"] != nil {
					perModelLimit = asInt(c["max_count"])
				}
			}
			if uses >= perModelLimit {
				continue
			}
			possible := true
			for _, id := range replaces {
				if cur.weapons[id] < 1 {
					possible = false
					break
				}
			}
			if !possible {
				continue
			}
			for _, bundle := range optionBundles(o) {
				if len(bundle) == 0 {
					continue
				}
				w := cloneCounts(cur.weapons)
				for _, id := range replaces {
					w[id]--
				}
				for _, id := range bundle {
					w[id]++
				}
				for id, count := range w {
					if count <= 0 {
						delete(w, id)
					}
				}
				used := append(append([]int(nil), cur.used...), oi)
				sort.Ints(used)
				key := stateKey(w, used)
				if _, duplicate := seen[key]; duplicate {
					continue
				}
				seen[key] = struct{}{}
				queue = append(queue, qItem{weapons: w, used: used})
			}
		}
	}
	return result
}

func cloneCounts(m map[string]int) map[string]int {
	out := make(map[string]int, len(m))
	for id, c := range m {
		out[id] = c
	}
	return out
}

func candidateCanBeSelected(candidate rowCandidate, upper map[string]int, optionCaps []int) bool {
	for id, per := range candidate.weapons {
		if per > 0 && upper[id] < per {
			return false
		}
	}
	for _, oi := range candidate.usedOptions {
		if optionCaps[oi] < 1 {
			return false
		}
	}
	return true
}

type pick struct{ ri, ci, count int }

// solveAssignment distributes rows within inclusive lower/upper item bounds.
// It intentionally charges repeated usedOptions by their multiplicity.
func solveAssignment(rows []solverRow, lower, upper map[string]int, optionCaps []int) []pick {
	remainingLower := cloneCounts(lower)
	remainingUpper := cloneCounts(upper)
	usage := make([]int, len(optionCaps))
	picks := []pick{}
	var assignRow func(int) bool
	var distribute func(int, int, int) bool
	assignRow = func(ri int) bool {
		if ri == len(rows) {
			for _, count := range remainingLower {
				if count > 0 {
					return false
				}
			}
			return true
		}
		return distribute(ri, 0, rows[ri].count)
	}
	distribute = func(ri, ci, left int) bool {
		row := rows[ri]
		if ci == len(row.candidates) {
			return left == 0 && assignRow(ri+1)
		}
		candidate := row.candidates[ci]
		hi := left
		for id, per := range candidate.weapons {
			if per > 0 {
				hi = minInt(hi, remainingUpper[id]/per)
			}
		}
		optionUses := map[int]int{}
		for _, oi := range candidate.usedOptions {
			optionUses[oi]++
		}
		for oi, perModel := range optionUses {
			hi = minInt(hi, (optionCaps[oi]-usage[oi])/perModel)
		}
		hi = maxInt(0, hi)
		for take := hi; take >= 0; take-- {
			for id, per := range candidate.weapons {
				remainingLower[id] -= per * take
				remainingUpper[id] -= per * take
			}
			for _, oi := range candidate.usedOptions {
				usage[oi] += take
			}
			if take > 0 {
				picks = append(picks, pick{ri, ci, take})
			}
			if distribute(ri, ci+1, left-take) {
				return true
			}
			if take > 0 {
				picks = picks[:len(picks)-1]
			}
			for _, oi := range candidate.usedOptions {
				usage[oi] -= take
			}
			for id, per := range candidate.weapons {
				remainingLower[id] += per * take
				remainingUpper[id] += per * take
			}
		}
		return false
	}
	if !assignRow(0) {
		return nil
	}
	return picks
}
func optionsWithPrintedUnitAbilities(unit map[string]any, options []any, counts map[string]int) []any {
	reachable := map[string]bool{}
	for _, optionAny := range options {
		option, _ := asMap(optionAny)
		for _, id := range getStrList(option, "replaces") {
			reachable[id] = true
		}
		for _, id := range getStrList(option, "replacement") {
			reachable[id] = true
		}
		for _, branch := range getList(option, "replacement_choice") {
			for _, id := range toStrList(branch) {
				reachable[id] = true
			}
		}
	}
	effective := append([]any(nil), options...)
	for _, id := range getStrList(unit, "ability_ids") {
		if counts[id] > 0 && !reachable[id] {
			effective = append(effective, map[string]any{
				"id":               getStr(unit, "id") + "-printed-ability-" + id,
				"replacement":      []any{id},
				"model_constraint": map[string]any{"max_count": counts[id]},
			})
		}
	}
	return effective
}

func filterRowCandidates(candidates []rowCandidate, upper map[string]int, optionCaps []int) []rowCandidate {
	out := make([]rowCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidateCanBeSelected(candidate, upper, optionCaps) {
			out = append(out, candidate)
		}
	}
	return out
}

// GroupLoadout proves and decomposes a flat loadout across every feasible
// per-model row allocation, trying the historical heuristic first.
func GroupLoadout(unit map[string]any, modelCount int, options []any, models []any, counts map[string]int) []any {
	if modelCount <= 1 || !hasRecordedDefaults(models) {
		return nil
	}
	bag := map[string]int{}
	for id, count := range counts {
		if count > 0 {
			bag[id] = count
		}
	}
	effectiveOptions := optionsWithPrintedUnitAbilities(unit, options, bag)

	for _, rowN := range candidateRowCounts(models, modelCount, bag) {
		fixedModels := make([]any, len(models))
		for i, modelAny := range models {
			model, _ := asMap(modelAny)
			fixed := cloneMap(model)
			fixed["min"] = rowN[i]
			fixed["max"] = rowN[i]
			fixedModels[i] = fixed
		}
		optionCaps := make([]int, len(effectiveOptions))
		for i, optionAny := range effectiveOptions {
			option, _ := asMap(optionAny)
			optionCaps[i] = optionCap(option, modelCount, fixedModels)
		}

		var rows []solverRow
		for i, modelAny := range models {
			count := rowN[i]
			if count == 0 {
				continue
			}
			model, _ := asMap(modelAny)
			base := toMultiset(getStrList(model, "default_weapon_ids"))
			candidates := enumerateRowCandidates(base, model["name"], effectiveOptions)
			candidates = filterRowCandidates(candidates, bag, optionCaps)
			sort.SliceStable(candidates, func(a, b int) bool {
				if candidates[a].key != candidates[b].key {
					return candidates[a].key < candidates[b].key
				}
				if len(candidates[a].usedOptions) != len(candidates[b].usedOptions) {
					return len(candidates[a].usedOptions) < len(candidates[b].usedOptions)
				}
				return joinInts(candidates[a].usedOptions) < joinInts(candidates[b].usedOptions)
			})
			rows = append(rows, solverRow{name: model["name"], count: count, candidates: candidates})
		}

		picks := solveAssignment(rows, bag, bag, optionCaps)
		if picks == nil {
			continue
		}
		type group struct {
			ri      int
			name    any
			weapons map[string]int
			count   int
			key     string
		}
		byGroup := map[string]*group{}
		var order []string
		for _, pick := range picks {
			candidate := rows[pick.ri].candidates[pick.ci]
			name, _ := rows[pick.ri].name.(string)
			key := name + "##" + candidate.key
			if current, ok := byGroup[key]; ok {
				current.count += pick.count
			} else {
				byGroup[key] = &group{
					ri: pick.ri, name: rows[pick.ri].name, weapons: candidate.weapons,
					count: pick.count, key: candidate.key,
				}
				order = append(order, key)
			}
		}
		live := make([]*group, 0, len(order))
		for _, key := range order {
			if byGroup[key].count > 0 {
				live = append(live, byGroup[key])
			}
		}
		sort.SliceStable(live, func(a, b int) bool {
			if live[a].ri != live[b].ri {
				return live[a].ri < live[b].ri
			}
			if live[a].count != live[b].count {
				return live[a].count > live[b].count
			}
			return live[a].key < live[b].key
		})
		if len(live) == 0 {
			continue
		}
		out := make([]any, 0, len(live))
		for _, group := range live {
			out = append(out, map[string]any{
				"model_name": group.name,
				"count":      group.count,
				"weapons":    sortedGroupWeapons(group.weapons),
			})
		}
		return out
	}
	return nil
}

type completedLoadout struct {
	counts map[string]int
	groups []any
	order  []string
}

func groupsFromPicks(rows []solverRow, picks []pick) []any {
	type group struct {
		ri      int
		name    any
		weapons map[string]int
		count   int
		key     string
	}
	byGroup := map[string]*group{}
	for _, choice := range picks {
		candidate := rows[choice.ri].candidates[choice.ci]
		name, _ := rows[choice.ri].name.(string)
		key := name + "##" + candidate.key
		if current := byGroup[key]; current != nil {
			current.count += choice.count
		} else {
			byGroup[key] = &group{ri: choice.ri, name: rows[choice.ri].name, weapons: candidate.weapons, count: choice.count, key: candidate.key}
		}
	}
	live := make([]*group, 0, len(byGroup))
	for _, group := range byGroup {
		if group.count > 0 {
			live = append(live, group)
		}
	}
	sort.SliceStable(live, func(a, b int) bool {
		if live[a].ri != live[b].ri {
			return live[a].ri < live[b].ri
		}
		if live[a].count != live[b].count {
			return live[a].count > live[b].count
		}
		return live[a].key < live[b].key
	})
	out := make([]any, 0, len(live))
	for _, group := range live {
		out = append(out, map[string]any{"model_name": group.name, "count": group.count, "weapons": sortedGroupWeapons(group.weapons)})
	}
	return out
}

// completeLoadout adds only composition defaults omitted by a source format.
// It never grants an unprinted optional selection.
func completeLoadout(unit map[string]any, modelCount int, options []any, models []any, explicitCounts map[string]int) *completedLoadout {
	if modelCount <= 0 || !hasRecordedDefaults(models) {
		return nil
	}
	strictLower := map[string]int{}
	for id, count := range explicitCounts {
		if count > 0 {
			strictLower[id] = count
		}
	}
	lowerVariants := []map[string]int{strictLower}
	defaultIDs := map[string]bool{}
	for _, modelAny := range models {
		model, _ := asMap(modelAny)
		for _, id := range getStrList(model, "default_weapon_ids") {
			defaultIDs[id] = true
		}
	}
	repeatedCoItems := map[string]bool{}
	for _, optionAny := range options {
		option, _ := asMap(optionAny)
		occurrences := map[string]int{}
		for _, branchAny := range getList(option, "replacement_choice") {
			branch := toStrList(branchAny)
			if len(branch) < 2 {
				continue
			}
			seen := map[string]bool{}
			for _, id := range branch {
				if !seen[id] {
					occurrences[id]++
					seen[id] = true
				}
			}
		}
		for id, count := range occurrences {
			if count >= 2 && !defaultIDs[id] {
				repeatedCoItems[id] = true
			}
		}
	}
	relaxedLower := cloneCounts(strictLower)
	for id := range repeatedCoItems {
		delete(relaxedLower, id)
	}
	if len(relaxedLower) != len(strictLower) {
		lowerVariants = append(lowerVariants, relaxedLower)
	}
	effectiveOptions := optionsWithPrintedUnitAbilities(unit, options, explicitCounts)
	for _, lower := range lowerVariants {
		for _, rowCounts := range candidateRowCounts(models, modelCount, lower) {
			fixedModels := make([]any, len(models))
			defaultCounts := map[string]int{}
			for i, modelAny := range models {
				model, _ := asMap(modelAny)
				fixed := cloneMap(model)
				fixed["min"], fixed["max"] = rowCounts[i], rowCounts[i]
				fixedModels[i] = fixed
				for _, id := range getStrList(fixed, "default_weapon_ids") {
					defaultCounts[id] += rowCounts[i]
				}
			}
			upper := cloneCounts(defaultCounts)
			for id, count := range explicitCounts {
				upper[id] = maxInt(upper[id], count)
			}
			optionCaps := make([]int, len(effectiveOptions))
			for i, optionAny := range effectiveOptions {
				option, _ := asMap(optionAny)
				optionCaps[i] = optionCap(option, modelCount, fixedModels)
			}
			rows := []solverRow{}
			for i, fixedAny := range fixedModels {
				if rowCounts[i] <= 0 {
					continue
				}
				fixed, _ := asMap(fixedAny)
				candidates := filterRowCandidates(enumerateRowCandidates(toMultiset(getStrList(fixed, "default_weapon_ids")), fixed["name"], effectiveOptions), upper, optionCaps)
				sort.SliceStable(candidates, func(a, b int) bool {
					if len(candidates[a].usedOptions) != len(candidates[b].usedOptions) {
						return len(candidates[a].usedOptions) < len(candidates[b].usedOptions)
					}
					if candidates[a].key != candidates[b].key {
						return candidates[a].key < candidates[b].key
					}
					return joinInts(candidates[a].usedOptions) < joinInts(candidates[b].usedOptions)
				})
				rows = append(rows, solverRow{name: fixed["name"], count: rowCounts[i], candidates: candidates})
			}
			picks := solveAssignment(rows, lower, upper, optionCaps)
			if picks == nil {
				continue
			}
			groups := groupsFromPicks(rows, picks)
			counts := map[string]int{}
			order := []string{}
			seen := map[string]bool{}
			for _, groupAny := range groups {
				group, _ := asMap(groupAny)
				for _, weaponAny := range getList(group, "weapons") {
					weapon, _ := asMap(weaponAny)
					id := getStr(weapon, "id")
					counts[id] += asInt(weapon["count"]) * asInt(group["count"])
					if !seen[id] {
						order = append(order, id)
						seen[id] = true
					}
				}
			}
			if modelCount <= 1 {
				groups = nil
			}
			return &completedLoadout{counts: counts, groups: groups, order: order}
		}
	}
	return nil
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
		// A replacement id can appear in multiple options / both choice branches;
		// sum the caps so its ceiling reflects every way to add it. Within one
		// branch, multiplicity counts: a twin-mount swap authored
		// ['lascannon','lascannon'] adds TWO per take (maximalLoadout already
		// honors this — collapsing to a set here capped every paired sponson,
		// Forgefiend ectoplasma, and 2-particle-beamer Spyder at half its legal
		// count). Across branches an id's ceiling uses its largest single branch.
		addMult := map[string]int{}
		var branches [][]string
		if o["replacement"] != nil {
			branches = [][]string{getStrList(o, "replacement")}
		} else {
			for _, group := range getList(o, "replacement_choice") {
				branches = append(branches, toStrList(group))
			}
		}
		for _, group := range branches {
			per := map[string]int{}
			for _, id := range group {
				per[id]++
			}
			for id, n := range per {
				if n > addMult[id] {
					addMult[id] = n
				}
			}
		}
		for id, n := range addMult {
			b := bounds[id]
			bounds[id] = intRange{b.min, b.max + cap*n}
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
	budgets := budgetViolations(unit, modelCount, counts)
	if len(models) > 1 && GroupLoadout(unit, modelCount, options, models, counts) != nil {
		return budgets
	}
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
	out = append(out, budgets...)
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
			// Only a plain, single-target, single-item swap of this exact base
			// weapon is unambiguous. A 1→N bundle (Lychguard warscythe → shield +
			// sword) yields TWO added copies per freed slot — summing each against
			// the slot pool double-counts every bundle swap, so it stays on the
			// looser bounds.
			if len(replaces) != 1 || len(getList(o, "replacement_choice")) > 0 || len(getStrList(o, "replacement")) > 1 {
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
		// A base weapon that is itself ADDABLE by another option lives on several
		// models' slots at once (the Krieg power weapon: the Commissar's default
		// AND a Veteran's chainsword upgrade) — the single-slot pool can't attribute
		// its copies, so it too stays on the per-id bounds.
		if messy || len(cleanAdds) == 0 || addedBy[base] > 0 {
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
		// Per-item sub-cap: at most duplicate_limit copies of any ONE item, on top
		// of the shared allowance. Mirror of the TS reference.
		if _, ok := budget["duplicate_limit"]; ok {
			dup := asInt(budget["duplicate_limit"])
			var dupCap int
			var dupLimit string
			if perModels > 0 {
				dupCap = int(math.Floor(float64(modelCount) * float64(dup) / float64(perModels)))
				dupLimit = itoa(dup) + " per " + itoa(perModels) + " models"
			} else {
				dupCap = dup
				dupLimit = itoa(dup) + " per unit"
			}
			sorted := append([]string(nil), items...)
			sort.Strings(sorted)
			for _, id := range sorted {
				n := counts[id]
				if n > dupCap {
					out = append(out, map[string]string{
						"id":      id,
						"code":    "exceeds-allowance",
						"message": id + ": " + itoa(n) + " exceeds per-item duplicate cap " + itoa(dupCap) + " (" + dupLimit + ")",
					})
				}
			}
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
