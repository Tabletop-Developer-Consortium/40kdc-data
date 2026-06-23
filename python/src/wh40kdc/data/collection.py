"""A queryable, iterable view over one entity collection.

Indexes (by id, by normalized name, by faction) are built once at
construction. Records are deduplicated by ``dedupe_key_of`` (default: id,
first occurrence wins). Some records are intentionally shared: the same unit
id (e.g. ``ministorum-priest``) appears under several factions, so units
dedupe on ``(faction_id, id)`` to keep each faction's copy; identical core
abilities (e.g. ``leader``) copied into many faction files dedupe away on
``ability_id``.

``get(id)``/``find`` return the first match when an id is shared across
factions; use :meth:`Collection.by_faction` or :meth:`Collection.find_all` to
disambiguate.

Python mirror of ``tools/src/data/collection.ts``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
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
    ) -> None:
        self._id_of = id_of
        self._name_of = name_of
        self._wrap = wrap
        self._items: list[T] = []
        self._by_id: dict[str, T] = {}
        self._by_norm: dict[str, list[T]] = {}
        self._by_faction_id: dict[str, list[T]] = {}

        dedupe = dedupe_key_of or id_of
        seen: set[str] = set()
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
                self._by_norm.setdefault(normalize_name(name), []).append(item)

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

            faction = faction_of(item) if faction_of else None
            if faction:
                self._by_faction_id.setdefault(faction, []).append(item)

    @property
    def all(self) -> list[V]:
        """Every record, deduplicated by id, in first-seen order."""
        return [self._wrap(item) for item in self._items]

    @property
    def size(self) -> int:
        """Number of distinct records."""
        return len(self._items)

    def get(self, id: str) -> V | None:
        """Look up by exact id."""
        item = self._by_id.get(id)
        return self._wrap(item) if item is not None else None

    def get_in_faction(self, id: str, faction_id: str) -> V | None:
        """Look up by exact id *within a faction*.

        Use this when an id is shared across factions and a faction context is
        known — :meth:`get` would return whichever copy was registered first,
        which may belong to the wrong faction.
        """
        for item in self._by_faction_id.get(faction_id, []):
            if self._id_of(item) == id:
                return self._wrap(item)
        return None

    def has(self, id: str) -> bool:
        """Whether a record with this exact id exists."""
        return id in self._by_id

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
        by_id = self._by_id.get(query)
        if by_id is not None:
            return [self._wrap(by_id)]

        key = normalize_name(query)
        exact = self._by_norm.get(key)
        if exact:
            return [self._wrap(item) for item in exact]

        if self._name_of is None or key == "":
            return []
        name_of = self._name_of
        return [
            self._wrap(item)
            for item in self._items
            if key in normalize_name(name_of(item) or "")
        ]

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
) -> Collection[Any, Any]:
    """Build a passthrough collection for an id-bearing record type."""
    return Collection(
        items,
        id_of=lambda i: i["id"],
        name_of=lambda i: i.get("name"),
        faction_of=faction_of,
        wrap=lambda i: i,
    )
