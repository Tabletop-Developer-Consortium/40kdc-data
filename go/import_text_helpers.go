package wh40kdc

import (
	"regexp"
	"strconv"
	"strings"
)

// Helpers shared by the NewRecruit text adapters (wtc, simple) and GW. Go
// mirror of python .../imports/newrecruit_text.py.

var battleSizesByLimit = []struct {
	upper int
	label string
}{
	{500, "Combat Patrol (500 Point limit)"},
	{1000, "Incursion (1000 Point limit)"},
	{2000, "Strike Force (2000 Point limit)"},
	{3000, "Onslaught (3000 Point limit)"},
}

// inferBattleSizeRaw synthesizes a battle_size_raw from a points limit. Returns
// nil when limit is nil.
func inferBattleSizeRaw(limit any) any {
	if limit == nil {
		return nil
	}
	l := asInt(limit)
	for _, b := range battleSizesByLimit {
		if l <= b.upper {
			return b.label
		}
	}
	return battleSizesByLimit[len(battleSizesByLimit)-1].label
}

var nxPrefixRe = regexp.MustCompile(`^(\d+)x\s+(.+)$`)
var inlinePtsRe = regexp.MustCompile(`(?i)^(.+?)\s*\[\s*(\d+)\s*pts?\s*\]\s*$`)
var inlineKeywordRe = regexp.MustCompile(`(?i)^40kdc Keywords?:\s*(.+)$`)
var inlineEnhancementRe = regexp.MustCompile(`(?i)^Enhancement:\s*(.+)$`)

const characterSuffix = " Character"
const warlordMarker = "Warlord"

type wargearClass struct {
	wargear            []any
	isWarlord          bool
	isCharacter        bool
	keywordOverrides   []string
	enhancementRawName any
	enhancementPoints  any
}

func classifyWargearList(tokens []string) wargearClass {
	res := wargearClass{wargear: []any{}}
	for _, raw := range tokens {
		token := strings.TrimSpace(raw)
		if token == "" {
			continue
		}
		if token == warlordMarker {
			res.isWarlord = true
			continue
		}
		if strings.HasSuffix(token, characterSuffix) {
			res.isCharacter = true
			res.keywordOverrides = append(res.keywordOverrides, "Character")
			continue
		}
		if m := inlineKeywordRe.FindStringSubmatch(token); m != nil {
			res.keywordOverrides = append(res.keywordOverrides, strings.TrimSpace(m[1]))
			continue
		}
		if m := inlinePtsRe.FindStringSubmatch(token); m != nil {
			if res.enhancementRawName == nil {
				res.enhancementRawName = strings.TrimSpace(m[1])
				n, _ := strconv.Atoi(m[2])
				res.enhancementPoints = float64(n)
			}
			continue
		}
		if m := inlineEnhancementRe.FindStringSubmatch(token); m != nil {
			if res.enhancementRawName == nil {
				res.enhancementRawName = strings.TrimSpace(m[1])
				res.enhancementPoints = nil
			}
			continue
		}
		if m := nxPrefixRe.FindStringSubmatch(token); m != nil {
			count, _ := strconv.Atoi(m[1])
			if count <= 0 {
				count = 1
			}
			res.wargear = append(res.wargear, map[string]any{"raw_name": strings.TrimSpace(m[2]), "count": float64(count)})
		} else {
			res.wargear = append(res.wargear, map[string]any{"raw_name": token, "count": float64(1)})
		}
	}
	return res
}

func splitWargearList(text string) []string {
	var out []string
	for _, part := range strings.Split(text, ",") {
		if s := strings.TrimSpace(part); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func stripParenthetical(name string) string {
	if idx := strings.Index(name, "("); idx >= 0 {
		return strings.TrimSpace(name[:idx])
	}
	return strings.TrimSpace(name)
}

func factionFromKeyword(value string) string {
	parts := strings.Split(value, " - ")
	return strings.TrimSpace(parts[len(parts)-1])
}

// orderedCounter is an insertion-ordered name->count aggregator (mirrors the
// Python dicts the text parsers use for wargear).
type orderedCounter struct {
	keys []string
	m    map[string]int
}

func newOrderedCounter() *orderedCounter { return &orderedCounter{m: map[string]int{}} }

func (o *orderedCounter) add(name string, c int) {
	if _, ok := o.m[name]; !ok {
		o.keys = append(o.keys, name)
	}
	o.m[name] += c
}

func (o *orderedCounter) empty() bool { return len(o.keys) == 0 }

func (o *orderedCounter) pairs() []any {
	out := make([]any, 0, len(o.keys))
	for _, k := range o.keys {
		out = append(out, map[string]any{"raw_name": k, "count": float64(o.m[k])})
	}
	return out
}

var splitLinesRe = regexp.MustCompile(`\r?\n`)

func splitLines(s string) []string { return splitLinesRe.Split(s, -1) }
