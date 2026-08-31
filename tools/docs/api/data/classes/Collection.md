[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [data](../README.md) / Collection

# Class: Collection\<T, V\>

Defined in: [data/collection.ts:45](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L45)

A collection of one entity type, exposing id/name/faction lookups.

Iterable: `for (const unit of units) { … }`.

## Type Parameters

### T

`T`

the raw (generated) record type

### V

`V`

the linked view type returned to callers

## Implements

- `Iterable`\<`V`\>

## Constructors

### Constructor

> **new Collection**\<`T`, `V`\>(`cfg`): `Collection`\<`T`, `V`\>

Defined in: [data/collection.ts:54](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L54)

#### Parameters

##### cfg

[`CollectionConfig`](../interfaces/CollectionConfig.md)\<`T`, `V`\>

#### Returns

`Collection`\<`T`, `V`\>

## Accessors

### all

#### Get Signature

> **get** **all**(): `V`[]

Defined in: [data/collection.ts:78](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L78)

Every record, deduplicated by id, in first-seen order.

##### Returns

`V`[]

***

### size

#### Get Signature

> **get** **size**(): `number`

Defined in: [data/collection.ts:83](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L83)

Number of distinct records.

##### Returns

`number`

## Methods

### get()

> **get**(`id`): `V` \| `undefined`

Defined in: [data/collection.ts:88](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L88)

Look up by exact id.

#### Parameters

##### id

`string`

#### Returns

`V` \| `undefined`

***

### getInFaction()

> **getInFaction**(`id`, `factionId`): `V` \| `undefined`

Defined in: [data/collection.ts:100](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L100)

Look up by exact id *within a faction*. Use this when an id is shared
across factions (e.g. `chaos-land-raider` lives under five Chaos factions)
and a faction context is known — [get](#get) would return whichever copy
was registered first, which may belong to the wrong faction. Returns
`undefined` when no record with that id belongs to `factionId`.

#### Parameters

##### id

`string`

##### factionId

`string`

#### Returns

`V` \| `undefined`

***

### has()

> **has**(`id`): `boolean`

Defined in: [data/collection.ts:107](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L107)

Whether a record with this exact id exists.

#### Parameters

##### id

`string`

#### Returns

`boolean`

***
### byExternalRef()

> **byExternalRef**(`namespace`, `id`): `V`[]

Defined in: [data/collection.ts:251](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/data/collection.ts#L251)

Return every canonical record carrying an exact external source identity.
External mappings are many-to-many: several records may share one source
identity, and one record may carry several ids from the same namespace.

#### Parameters

##### namespace

`string`

##### id

`string`

#### Returns

`V`[]

***


### find()

> **find**(`query`): `V` \| `undefined`

Defined in: [data/collection.ts:121](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L121)

Find one record by id or name. Name matching is diacritic- and
punctuation-insensitive (see [normalizeName](../functions/normalizeName.md)), trying, in order:
exact id → exact normalized name → normalized-name substring. Returns the
first match; names can repeat across factions, so use [findAll](#findall) or
[byFaction](#byfaction) when a query may be ambiguous.

#### Parameters

##### query

`string`

#### Returns

`V` \| `undefined`

#### Example

```ts
units.find("Kharn"); // resolves "Khârn the Betrayer"
```

***

### findAll()

> **findAll**(`query`): `V`[]

Defined in: [data/collection.ts:131](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L131)

All records matching a query, by the same rules as [find](#find). An exact id
match returns just that record; otherwise every normalized-name-exact match
is returned, falling back to every normalized-name-substring match. Useful
to surface (rather than silently collapse) names shared across factions.

#### Parameters

##### query

`string`

#### Returns

`V`[]

***

### byFaction()

> **byFaction**(`factionId`): `V`[]

Defined in: [data/collection.ts:146](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L146)

All records belonging to a faction id (empty if the type has no faction).

#### Parameters

##### factionId

`string`

#### Returns

`V`[]

***

### \[iterator\]()

> **\[iterator\]**(): `Iterator`\<`V`\>

Defined in: [data/collection.ts:150](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L150)

#### Returns

`Iterator`\<`V`\>

#### Implementation of

`Iterable.[iterator]`
