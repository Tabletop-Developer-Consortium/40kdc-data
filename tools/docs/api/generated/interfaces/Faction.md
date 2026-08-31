[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [generated](../README.md) / Faction

# Interface: Faction

Defined in: [generated.ts:378](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L378)

A playable faction or sub-faction.

This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
via the `definition` "faction".

## Properties

### id

> **id**: `string`

Defined in: [generated.ts:379](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L379)

***
### external\_refs?

> `optional` **external\_refs?**: [`ExternalReferenceList`](../type-aliases/ExternalReferenceList.md)

Defined in: [generated.ts:940](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/generated.ts#L940)

***


### name

> **name**: `string`

Defined in: [generated.ts:380](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L380)

***

### parent\_faction\_id?

> `optional` **parent\_faction\_id?**: `string` \| `null`

Defined in: [generated.ts:381](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L381)

***

### game\_version

> **game\_version**: [`GameVersionReference`](GameVersionReference.md)

Defined in: [generated.ts:382](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L382)

***

### keywords?

> `optional` **keywords?**: [`KeywordList`](../type-aliases/KeywordList.md)

Defined in: [generated.ts:383](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L383)

***

### aliases?

> `optional` **aliases?**: `string`[]

Defined in: [generated.ts:384](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L384)

***

### faction\_rule\_id?

> `optional` **faction\_rule\_id?**: `string` \| `null`

Defined in: [generated.ts:388](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L388)

Reference to the faction-wide ability (e.g., Oath of Moment)
