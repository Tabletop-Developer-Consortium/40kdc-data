"""A queryable, iterable view over one entity collection.

Indexes (by id, by normalized name, by faction) are built once at
construction. Records are deduplicated by ``dedupe_key_of`` (default: id,
first occurrence wins). Some records are intentionally shared: the same id
(e.g. unit ``ministorum-priest``, ability ``deadly-demise-d3``) appears under
several factions with per-faction copies that may diverge, so those
collections dedupe on ``(faction_id, id)`` to keep each faction's copy and
resolve via :meth:`Collection.get_in_faction`.

``find`` returns the first match when an id is shared across factions; use
:meth:`Collection.by_faction` or :meth:`Collection.find_all` to disambiguate.
Collections whose per-faction copies diverge set ``guard_unscoped`` so a
faction-less :meth:`Collection.get` of a shared id raises under ``__debug__``
(any run without ``-O`` — the Python analogue of the TS non-production
tripwire); deliberately faction-less callers use :meth:`Collection.get_any`.

Python mirror of ``tools/src/data/collection.ts``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from typing import Any, Generic, TypeVar

from wh40kdc.data.normalize import normalize_name

T = TypeVar("T")
V = TypeVar("V")


class Collection(Generic[T, V]):
    """A collection of one entity type, exposing id/name/faction lookups.

    Iterable: ``for unit in units: ...``.
    """

    def __init__(
        self,
        items: list[T],
        *,
        id_of: Callable[[T], str],
        wrap: Callable[[T], V],
        dedupe_key_of: Callable[[T], str] | None = None,
        name_of: Callable[[T], str | None] | None = None,
        aliases_of: Callable[[T], list[str] | None] | None = None,
        faction_of: Callable[[T], str | None] | None = None,
        external_refs_of: Callable[[T], list[Mapping[str, str]] | None] | None = None,
        guard_unscoped: bool = False,
        entity_label: str = "entity",
        id_aliases: Mapping[str, str] | None = None,
    ) -> None:
        self._id_of = id_of
        self._name_of = name_of
        self._wrap = wrap
        # Renamed-id map (old id -> current id), consulted by id lookups only on
        # a _by_id miss so a persisted reference to a since-renamed id still
        # resolves. Pre-flattened, so one hop suffices. Mirror of the TS idAliases.
        self._id_aliases = id_aliases
        self._items: list[T] = []
        self._by_id: dict[str, T] = {}
        self._by_norm: dict[str, list[T]] = {}
        # (normalized name, item) in first-seen order, for the substring fallback in
        # find_all: it is already computed below for _by_norm, and re-deriving it
        # per lookup made every miss a full scan through name_of and normalize_name.
        self._norm_names: list[tuple[str, T]] = []
        self._by_faction_id: dict[str, list[T]] = {}
        # (faction id, item id) -> first-registered item, for get_in_faction.
        self._by_faction_and_id: dict[tuple[str, str], T] = {}
        self._by_external_ref: dict[tuple[str, str], list[T]] = {}
        # Ids registered under >1 faction; only populated when guarding.
        self._ambiguous_ids: set[str] | None = set() if guard_unscoped else None
        self._entity_label = entity_label

        dedupe = dedupe_key_of or id_of
        seen: set[str] = set()
        # id -> distinct faction ids it appears under (only tracked when guarding).
        id_factions: dict[str, set[str]] | None = {} if guard_unscoped else None
        for item in items:
            dedupe_key = dedupe(item)
            if dedupe_key in seen:
                continue  # first-wins dedup
            seen.add(dedupe_key)
            self._items.append(item)

            id_ = id_of(item)
            if id_ not in self._by_id:
                self._by_id[id_] = item  # first-wins for shared ids

            name = name_of(item) if name_of else None
            if name:
                norm = normalize_name(name)
                self._by_norm.setdefault(norm, []).append(item)
                self._norm_names.append((norm, item))

            # Alias names answer to the same record. Index them after the
            # canonical name and skip any alias that normalizes to the
            # record's own name, so an alias can never displace the canonical
            # owner of a normalized key.
            name_key = normalize_name(name) if name else None
            for alias in (aliases_of(item) if aliases_of else None) or []:
                alias_key = normalize_name(alias)
                if alias_key == "" or alias_key == name_key:
                    continue
                self._by_norm.setdefault(alias_key, []).append(item)

            for ref in (external_refs_of(item) if external_refs_of else None) or []:
                namespace = ref.get("namespace")
                external_id = ref.get("id")
                if namespace and external_id:
                    self._by_external_ref.setdefault((namespace, external_id), []).append(item)

            faction = faction_of(item) if faction_of else None
            if faction:
                self._by_faction_id.setdefault(faction, []).append(item)
                self._by_faction_and_id.setdefault((faction, id_), item)
                if id_factions is not None:
                    id_factions.setdefault(id_, set()).add(faction)

        if id_factions is not None and self._ambiguous_ids is not None:
            for id_, factions in id_factions.items():
                if len(factions) > 1:
                    self._ambiguous_ids.add(id_)

    @property
    def all(self) -> list[V]:
        """Every record, deduplicated by id, in first-seen order."""
        return [self._wrap(item) for item in self._items]

    @property
    def size(self) -> int:
        """Number of distinct records."""
        return len(self._items)

    def get(self, id: str) -> V | None:
        """Look up by exact id.

        For a guarded collection (``guard_unscoped=True``), an id that exists
        under more than one faction raises under ``__debug__`` — pass a
        faction via :meth:`get_in_faction`, or call :meth:`get_any` when
        faction is genuinely unknown. Running with ``-O`` degrades to the
        historical first-wins behaviour.
        """
        if __debug__ and self._ambiguous_ids is not None and id in self._ambiguous_ids:
            raise LookupError(
                f'Ambiguous {self._entity_label} lookup: "{id}" exists under multiple '
                f"factions; a faction-less get() would return whichever copy registered "
                f'first (wrong divergent fields). Use get_in_faction("{id}", faction_id), '
                f'or get_any("{id}") when faction is genuinely unknown (import / conformance).'
            )
        item = self._raw_by_id(id)
        return self._wrap(item) if item is not None else None

    def _raw_by_id(self, id: str) -> T | None:
        """Raw record for an id: exact ``_by_id``, falling back through the
        renamed-id map (one hop) on a miss so a persisted reference to a
        renamed id still resolves."""
        item = self._by_id.get(id)
        if item is not None:
            return item
        if self._id_aliases is not None:
            new_id = self._id_aliases.get(id)
            if new_id is not None:
                return self._by_id.get(new_id)
        return None

    def get_any(self, id: str) -> V | None:
        """First-wins lookup by exact id that never raises.

        For callers with no faction context on purpose (roster import, the
        conformance runner). For a guarded collection this is the explicit
        opt-out of :meth:`get`'s ambiguity tripwire; for an unguarded one it
        is identical to :meth:`get`. Renamed ids resolve via the alias map.
        """
        item = self._raw_by_id(id)
        return self._wrap(item) if item is not None else None

    def get_in_faction(self, id: str, faction_id: str) -> V | None:
        """Look up by exact id *within a faction*.

        Use this when an id is shared across factions and a faction context is
        known — :meth:`get` would return whichever copy was registered first,
        which may belong to the wrong faction.
        """
        # Resolve a renamed id to its current form before scoping to the faction.
        resolved = id
        if id not in self._by_id and self._id_aliases is not None:
            resolved = self._id_aliases.get(id, id)
        item = self._by_faction_and_id.get((faction_id, resolved))
        return self._wrap(item) if item is not None else None

    def has(self, id: str) -> bool:
        """Whether a record with this exact id (or a renamed alias of it) exists."""
        return self._raw_by_id(id) is not None

    def by_external_ref(self, namespace: str, id: str) -> list[V]:
        """Return every record carrying an exact external source identity.

        External mappings are many-to-many, so this always returns a list.
        """
        return [self._wrap(item) for item in self._by_external_ref.get((namespace, id), [])]

    def find(self, query: str) -> V | None:
        """Find one record by id or name.

        Name matching is diacritic- and punctuation-insensitive (see
        :func:`normalize_name`), trying, in order: exact id → exact normalized
        name → normalized-name substring. Returns the first match; names can
        repeat across factions, so use :meth:`find_all` or :meth:`by_faction`
        when a query may be ambiguous.
        """
        matches = self.find_all(query)
        return matches[0] if matches else None

    def find_all(self, query: str) -> list[V]:
        """All records matching a query, by the same rules as :meth:`find`.

        An exact id match returns just that record; otherwise every
        normalized-name-exact match is returned, falling back to every
        normalized-name-substring match.
        """
        by_id = self._raw_by_id(query)
        if by_id is not None:
            return [self._wrap(by_id)]

        key = normalize_name(query)
        exact = self._by_norm.get(key)
        if exact:
            return [self._wrap(item) for item in exact]

        if self._name_of is None or key == "":
            return []
        return [self._wrap(item) for norm, item in self._norm_names if key in norm]

    def by_faction(self, faction_id: str) -> list[V]:
        """All records belonging to a faction id (empty if the type has no faction)."""
        return [self._wrap(item) for item in self._by_faction_id.get(faction_id, [])]

    def __iter__(self) -> Iterator[V]:
        return iter(self._wrap(item) for item in self._items)

    def __len__(self) -> int:
        return len(self._items)


def id_collection(
    items: list[Any],
    faction_of: Callable[[Any], str | None] | None = None,
    *,
    id_aliases: Mapping[str, str] | None = None,
) -> Collection[Any, Any]:
    """Build a passthrough collection for an id-bearing record type.

    Defaults ``id_aliases`` to the share registry's rename map so a persisted
    reference to a renamed id still resolves (harmless for record types absent
    from the registry — their ids are never alias keys).
    """
    if id_aliases is None:
        from wh40kdc.share import embedded_registry_aliases

        id_aliases = embedded_registry_aliases()
    return Collection(
        items,
        id_of=lambda i: i["id"],
        name_of=lambda i: i.get("name"),
        faction_of=faction_of,
        external_refs_of=lambda i: i.get("external_refs"),
        wrap=lambda i: i,
        id_aliases=id_aliases,
    )
