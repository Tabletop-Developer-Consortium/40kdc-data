package wh40kdc

import "strings"

// A queryable view over one entity collection. Indexes (by id, by normalized
// name, by faction) are built once at construction. Records are deduplicated by
// dedupeKeyOf (default: id, first occurrence wins). Some records are
// intentionally shared across factions (e.g. ministorum-priest), so units
// dedupe on (faction_id, id); identical core abilities dedupe on ability_id.
//
// Go mirror of python .../data/collection.py.

type collectionOpts struct {
	idOf        func(any) string
	dedupeKeyOf func(any) string
	nameOf      func(any) string   // returns "" for no name
	aliasesOf   func(any) []string // alternate names answering to the same record
	factionOf   func(any) string   // returns "" for no faction
}

// Collection is a collection of one entity type, parameterised by its wrapped
// view type V.
type Collection[V any] struct {
	idOf      func(any) string
	nameOf    func(any) string
	wrap      func(any) V
	items     []any
	byID      map[string]any
	byNorm    map[string][]any
	byFaction map[string][]any
}

func newCollection[V any](items []any, wrap func(any) V, opts collectionOpts) *Collection[V] {
	c := &Collection[V]{
		idOf:      opts.idOf,
		nameOf:    opts.nameOf,
		wrap:      wrap,
		items:     make([]any, 0, len(items)),
		byID:      make(map[string]any),
		byNorm:    make(map[string][]any),
		byFaction: make(map[string][]any),
	}
	dedupe := opts.dedupeKeyOf
	if dedupe == nil {
		dedupe = opts.idOf
	}
	seen := make(map[string]struct{})
	for _, item := range items {
		key := dedupe(item)
		if _, dup := seen[key]; dup {
			continue // first-wins dedup
		}
		seen[key] = struct{}{}
		c.items = append(c.items, item)

		id := opts.idOf(item)
		if _, exists := c.byID[id]; !exists {
			c.byID[id] = item // first-wins for shared ids
		}
		var nameKey string
		if opts.nameOf != nil {
			if name := opts.nameOf(item); name != "" {
				nameKey = NormalizeName(name)
				c.byNorm[nameKey] = append(c.byNorm[nameKey], item)
			}
		}
		// Alias names answer to the same record. Index them after the canonical
		// name and skip any alias that normalizes to an already-registered name,
		// so an alias can never displace the canonical owner of a normalized key.
		if opts.aliasesOf != nil {
			for _, alias := range opts.aliasesOf(item) {
				aliasKey := NormalizeName(alias)
				if aliasKey == "" || aliasKey == nameKey {
					continue
				}
				c.byNorm[aliasKey] = append(c.byNorm[aliasKey], item)
			}
		}
		if opts.factionOf != nil {
			if f := opts.factionOf(item); f != "" {
				c.byFaction[f] = append(c.byFaction[f], item)
			}
		}
	}
	return c
}

// All returns every record, deduplicated by id, in first-seen order.
func (c *Collection[V]) All() []V {
	out := make([]V, len(c.items))
	for i, item := range c.items {
		out[i] = c.wrap(item)
	}
	return out
}

// Size returns the number of distinct records.
func (c *Collection[V]) Size() int { return len(c.items) }

// Get looks up by exact id.
func (c *Collection[V]) Get(id string) (V, bool) {
	item, ok := c.byID[id]
	if !ok {
		var zero V
		return zero, false
	}
	return c.wrap(item), true
}

// GetInFaction looks up by exact id within a faction.
func (c *Collection[V]) GetInFaction(id, factionID string) (V, bool) {
	for _, item := range c.byFaction[factionID] {
		if c.idOf(item) == id {
			return c.wrap(item), true
		}
	}
	var zero V
	return zero, false
}

// Has reports whether a record with this exact id exists.
func (c *Collection[V]) Has(id string) bool {
	_, ok := c.byID[id]
	return ok
}

// Find finds one record by id or name (first match).
func (c *Collection[V]) Find(query string) (V, bool) {
	matches := c.FindAll(query)
	if len(matches) == 0 {
		var zero V
		return zero, false
	}
	return matches[0], true
}

// FindAll returns all records matching a query: exact id → exact normalized
// name → normalized-name substring.
func (c *Collection[V]) FindAll(query string) []V {
	if item, ok := c.byID[query]; ok {
		return []V{c.wrap(item)}
	}
	key := NormalizeName(query)
	if exact, ok := c.byNorm[key]; ok && len(exact) > 0 {
		out := make([]V, len(exact))
		for i, item := range exact {
			out[i] = c.wrap(item)
		}
		return out
	}
	if c.nameOf == nil || key == "" {
		return nil
	}
	var out []V
	for _, item := range c.items {
		if strings.Contains(NormalizeName(c.nameOf(item)), key) {
			out = append(out, c.wrap(item))
		}
	}
	return out
}

// ByFaction returns all records belonging to a faction id.
func (c *Collection[V]) ByFaction(factionID string) []V {
	items := c.byFaction[factionID]
	out := make([]V, len(items))
	for i, item := range items {
		out[i] = c.wrap(item)
	}
	return out
}

// idCollection builds a passthrough collection for an id-bearing record type
// (the view is the raw record itself).
func idCollection(items []any, factionOf func(any) string) *Collection[any] {
	return newCollection[any](items, func(i any) any { return i }, collectionOpts{
		idOf:      func(i any) string { return getStr(i.(map[string]any), "id") },
		nameOf:    func(i any) string { return getStr(i.(map[string]any), "name") },
		factionOf: factionOf,
	})
}
