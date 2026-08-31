[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [data](../README.md) / CollectionConfig

# Interface: CollectionConfig\<T, V\>

Defined in: [data/collection.ts:19](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L19)

How a [Collection](../classes/Collection.md) reads keys and builds views from raw records.

## Type Parameters

### T

`T`

### V

`V`

## Properties

### items

> **items**: `T`[]

Defined in: [data/collection.ts:20](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L20)

***

### idOf

> **idOf**: (`item`) => `string`

Defined in: [data/collection.ts:22](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L22)

Primary id of a record (e.g. `u => u.id`, `a => a.ability_id`).

#### Parameters

##### item

`T`

#### Returns

`string`

***

### dedupeKeyOf?

> `optional` **dedupeKeyOf?**: (`item`) => `string`

Defined in: [data/collection.ts:28](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L28)

Uniqueness key used for deduplication. Defaults to [idOf](#idof). Set to a
composite (e.g. `(faction_id, id)`) for records that share an id across
factions, so distinct copies are preserved rather than collapsed.

#### Parameters

##### item

`T`

#### Returns

`string`

***

### nameOf?

> `optional` **nameOf?**: (`item`) => `string` \| `undefined`

Defined in: [data/collection.ts:30](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L30)

Display name, if the record has one — drives [Collection.find](../classes/Collection.md#find).

#### Parameters

##### item

`T`

#### Returns

`string` \| `undefined`

***
### externalRefsOf?

> `optional` **externalRefsOf?**: (`item`) => readonly `object`[] \| `null` \| `undefined`

Defined in: [data/collection.ts:69](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/data/collection.ts#L69)

Stable source identities indexed by [Collection.byExternalRef](../classes/Collection.md#byexternalref).

#### Parameters

##### item

`T`

#### Returns

readonly `object`[] \| `null` \| `undefined`

***


### factionOf?

> `optional` **factionOf?**: (`item`) => `string` \| `null` \| `undefined`

Defined in: [data/collection.ts:32](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L32)

Owning faction id, if applicable — drives [Collection.byFaction](../classes/Collection.md#byfaction).

#### Parameters

##### item

`T`

#### Returns

`string` \| `null` \| `undefined`

***

### wrap

> **wrap**: (`item`) => `V`

Defined in: [data/collection.ts:34](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/data/collection.ts#L34)

Wrap a raw record in its linked view.

#### Parameters

##### item

`T`

#### Returns

`V`
