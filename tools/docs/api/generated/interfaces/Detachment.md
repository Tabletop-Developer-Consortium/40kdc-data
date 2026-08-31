[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [generated](../README.md) / Detachment

# Interface: Detachment

Defined in: [generated.ts:321](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L321)

A detachment option within a faction, providing a detachment rule, enhancements, and stratagems.

This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
via the `definition` "detachment".

## Properties

### id

> **id**: `string`

Defined in: [generated.ts:322](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L322)

***
### external\_refs?

> `optional` **external\_refs?**: [`ExternalReferenceList`](../type-aliases/ExternalReferenceList.md)

Defined in: [generated.ts:848](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/generated.ts#L848)

***


### name

> **name**: `string`

Defined in: [generated.ts:323](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L323)

***

### faction\_id

> **faction\_id**: `string`

Defined in: [generated.ts:324](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L324)

***

### detachment\_rule\_id?

> `optional` **detachment\_rule\_id?**: `string` \| `null`

Defined in: [generated.ts:325](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L325)

***

### detachment\_points?

> `optional` **detachment\_points?**: `number` \| `null`

Defined in: [generated.ts:329](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L329)

11e: the detachment-point cost (1–3) charged against the army's detachment-point budget. null when not yet assigned.

***

### force\_dispositions?

> `optional` **force\_dispositions?**: `string`[]

Defined in: [generated.ts:333](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L333)

11e: ids of the Force Disposition entities this detachment grants. Empty until assigned.

***

### enhancement\_ids?

> `optional` **enhancement\_ids?**: `string`[]

Defined in: [generated.ts:334](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L334)

***

### stratagem\_ids?

> `optional` **stratagem\_ids?**: `string`[]

Defined in: [generated.ts:335](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L335)

***

### restrictions?

> `optional` **restrictions?**: \{ `required_keywords?`: [`KeywordList`](../type-aliases/KeywordList.md); `excluded_keywords?`: [`KeywordList`](../type-aliases/KeywordList.md); `notes?`: `string`; \} \| `null`

Defined in: [generated.ts:336](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L336)

***

### game\_version

> **game\_version**: [`GameVersionReference`](GameVersionReference.md)

Defined in: [generated.ts:341](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L341)
