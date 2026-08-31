package wh40kdc

import (
	"fmt"
	"strings"
)

// A queryable view over one entity collection. Indexes (by id, by normalized
// name, by faction) are built once at construction. Records are deduplicated
// by dedupeKeyOf (default: id, first occurrence wins). Some records are
// intentionally shared: the same id (e.g. unit ministorum-priest, ability
// deadly-demise-d3) appears under several factions with per-faction copies
// that may diverge, so those collections dedupe on (faction_id, id) and
// resolve via GetInFaction. Collections whose per-faction copies diverge set
// guardUnscoped so a faction-less Get of a shared id panics (Go has no
// debug/release split, so the tripwire is always on — the message points at
// GetInFaction/GetAny); deliberately faction-less callers use GetAny.
//
// Go mirror of python .../data/collection.py.

type collectionOpts struct {
	idOf        func(any) string
	dedupeKeyOf func(any) string
	nameOf      func(any) string   // returns "" for no name
	aliasesOf   func(any) []string // alternate names answering to the same record
	factionOf   func(any) string   // returns "" for no faction
	// guardUnscoped makes Get panic for an id registered under >1 faction (a
	// faction-less lookup would silently return the wrong divergent copy).
	guardUnscoped bool
	// entityLabel is the noun used in the guard panic message (e.g. "unit").
	entityLabel string
	// idAliases maps an old id to its current id; consulted by id lookups only
	// on a byID miss so a persisted reference to a renamed id still resolves.
	// Pre-flattened, so one hop suffices. Go mirror of the TS idAliases.
	idAliases map[string]string
}

// Collection is a collection of one entity type, parameterised by its wrapped
// view type V.
type Collection[V any] struct {
	idOf          func(any) string
	nameOf        func(any) string
	wrap          func(any) V
	items         []any
	byID          map[string]any
	byNorm        map[string][]any
	byFaction     map[string][]any
	byExternalRef map[string][]any
	// Ids registered under >1 faction; nil unless guardUnscoped.
	ambiguousIDs map[string]struct{}
	entityLabel  string
	// Renamed-id map (old id -> current id); nil unless set via opts.
	idAliases map[string]string
}

func newCollection[V any](items []any, wrap func(any) V, opts collectionOpts) *Collection[V] {
	c := &Collection[V]{
		idOf:          opts.idOf,
		nameOf:        opts.nameOf,
		wrap:          wrap,
		items:         make([]any, 0, len(items)),
		byID:          make(map[string]any),
		byNorm:        make(map[string][]any),
		byFaction:     make(map[string][]any),
		byExternalRef: make(map[string][]any),
		idAliases:     opts.idAliases,
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
		if record, ok := item.(map[string]any); ok {
			for _, value := range getList(record, "external_refs") {
				ref, ok := value.(map[string]any)
				if !ok {
					continue
				}
				namespace, id := getStr(ref, "namespace"), getStr(ref, "id")
				if namespace != "" && id != "" {
					key := namespace + "\x00" + id
					c.byExternalRef[key] = append(c.byExternalRef[key], item)
				}
			}
		}
		if opts.factionOf != nil {
			if f := opts.factionOf(item); f != "" {
				c.byFaction[f] = append(c.byFaction[f], item)
			}
		}
	}
	if opts.guardUnscoped {
		c.entityLabel = opts.entityLabel
		if c.entityLabel == "" {
			c.entityLabel = "entity"
		}
		// id -> distinct factions it appears under; >1 = ambiguous.
		idFactions := make(map[string]map[string]struct{})
		for f, items := range c.byFaction {
			for _, item := range items {
				id := opts.idOf(item)
				if idFactions[id] == nil {
					idFactions[id] = make(map[string]struct{})
				}
				idFactions[id][f] = struct{}{}
			}
		}
		c.ambiguousIDs = make(map[string]struct{})
		for id, factions := range idFactions {
			if len(factions) > 1 {
				c.ambiguousIDs[id] = struct{}{}
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
//
// For a guarded collection (guardUnscoped), an id that exists under more than
// one faction panics — a faction-less lookup would silently return whichever
// copy registered first, with the wrong divergent fields. Pass a faction via
// GetInFaction, or call GetAny when faction is genuinely unknown.
func (c *Collection[V]) Get(id string) (V, bool) {
	if c.ambiguousIDs != nil {
		if _, ambiguous := c.ambiguousIDs[id]; ambiguous {
			panic(fmt.Sprintf(
				"Ambiguous %s lookup: %q exists under multiple factions; a faction-less "+
					"Get would return whichever copy registered first (wrong divergent fields). "+
					"Use GetInFaction(%q, factionID), or GetAny(%q) when faction is genuinely "+
					"unknown (import / conformance).",
				c.entityLabel, id, id, id,
			))
		}
	}
	return c.GetAny(id)
}

// GetAny is the first-wins lookup by exact id that never panics, for callers
// with no faction context on purpose (roster import, the conformance runner).
// For a guarded collection this is the explicit opt-out of Get's ambiguity
// tripwire; for an unguarded one it is identical to Get.
func (c *Collection[V]) GetAny(id string) (V, bool) {
	item, ok := c.rawByID(id)
	if !ok {
		var zero V
		return zero, false
	}
	return c.wrap(item), true
}

// rawByID returns the raw record for an id: exact byID, falling back through the
// idAliases map (one hop) on a miss so a persisted reference to a renamed id
// still resolves.
func (c *Collection[V]) rawByID(id string) (any, bool) {
	if item, ok := c.byID[id]; ok {
		return item, true
	}
	if c.idAliases != nil {
		if newID, ok := c.idAliases[id]; ok {
			item, ok := c.byID[newID]
			return item, ok
		}
	}
	return nil, false
}

// GetInFaction looks up by exact id within a faction.
func (c *Collection[V]) GetInFaction(id, factionID string) (V, bool) {
	// Resolve a renamed id to its current form before scoping to the faction.
	resolved := id
	if _, ok := c.byID[id]; !ok && c.idAliases != nil {
		if newID, ok := c.idAliases[id]; ok {
			resolved = newID
		}
	}
	for _, item := range c.byFaction[factionID] {
		if c.idOf(item) == resolved {
			return c.wrap(item), true
		}
	}
	var zero V
	return zero, false
}

// Has reports whether a record with this exact id (or a renamed alias of it) exists.
func (c *Collection[V]) Has(id string) bool {
	_, ok := c.rawByID(id)
	return ok
}

// ByExternalRef returns every record carrying an exact external source
// identity. External mappings are many-to-many, so this always returns a slice.
func (c *Collection[V]) ByExternalRef(namespace, id string) []V {
	items := c.byExternalRef[namespace+"\x00"+id]
	out := make([]V, len(items))
	for i, item := range items {
		out[i] = c.wrap(item)
	}
	return out
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
	if item, ok := c.rawByID(query); ok {
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
		// Resolve a persisted reference to a renamed id (harmless for record
		// types absent from the registry — their ids are never alias keys).
		idAliases: embeddedRegistryAliases(),
	})
}
