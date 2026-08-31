[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [generated](../README.md) / Unit

# Interface: Unit

Defined in: [generated.ts:1167](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1167)

A unit datasheet entry with stat profiles and point costs.

This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
via the `definition` "unit".

## Properties

### id

> **id**: `string`

Defined in: [generated.ts:1168](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1168)

***
### external\_refs?

> `optional` **external\_refs?**: [`ExternalReferenceList`](../type-aliases/ExternalReferenceList.md)

Defined in: [generated.ts:2460](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/generated.ts#L2460)

***


### name

> **name**: `string`

Defined in: [generated.ts:1169](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1169)

***

### faction\_id

> **faction\_id**: `string`

Defined in: [generated.ts:1170](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1170)

***

### role?

> `optional` **role?**: `"character"` \| `"battleline"` \| `"dedicated-transport"` \| `"fortification"` \| `"allied"` \| `"epic-hero"`

Defined in: [generated.ts:1174](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1174)

Battlefield role from the datasheet header. Unit types (Infantry, Vehicle, etc.) belong in keywords.

***

### attachment\_role?

> `optional` **attachment\_role?**: `"leader"` \| `"support"` \| `null`

Defined in: [generated.ts:1178](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1178)

Character attachment role (11e). 'support' implies the unit is only legal when attached to a host unit (cannot be taken solo); 'leader' is valid as a standalone list entry. null/absent for non-attaching units.

***

### profiles

> **profiles**: \[\{\[`k`: `string`\]: `unknown`; `name?`: `string`; `M`: [`StatValue`](../type-aliases/StatValue.md); `T`: `number`; `W`: `number`; `Sv`: `number`; `invuln_sv?`: `number` \| `null`; `Ld`: `number`; `OC`: `number`; \}, ...\{ name?: string; M: StatValue; T: number; W: number; Sv: number; invuln\_sv?: number \| null; Ld: number; OC: number; \[k: string\]: unknown \}\[\]\]

Defined in: [generated.ts:1182](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1182)

#### Min Items

1

***

### points?

> `optional` **points?**: `object`[]

Defined in: [generated.ts:1212](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1212)

#### Index Signature

\[`k`: `string`\]: `unknown`

#### models

> **models**: `number`

#### cost

> **cost**: `number`

***

### points\_provisional?

> `optional` **points\_provisional?**: `boolean`

Defined in: [generated.ts:1220](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1220)

True when point costs are carried over provisionally (e.g. seeded from a prior edition during migration) and not yet confirmed against the current dataslate.

***

### keywords?

> `optional` **keywords?**: [`KeywordList`](../type-aliases/KeywordList.md)

Defined in: [generated.ts:1221](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1221)

***

### faction\_keywords?

> `optional` **faction\_keywords?**: [`KeywordList`](../type-aliases/KeywordList.md)

Defined in: [generated.ts:1222](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1222)

***

### base\_size\_mm?

> `optional` **base\_size\_mm?**: [`BaseSize`](BaseSize.md) \| `null`

Defined in: [generated.ts:1226](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1226)

The unit's representative base (the most-numerous model's base). Mixed-model units carry the full per-model breakdown in unit-composition; this top-level value is a convenience for consumers that need a single base.

***

### model\_count?

> `optional` **model\_count?**: `object`

Defined in: [generated.ts:1227](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1227)

#### Index Signature

\[`k`: `string`\]: `unknown`

#### min

> **min**: `number`

#### max

> **max**: `number`

***

### weapon\_ids?

> `optional` **weapon\_ids?**: `string`[]

Defined in: [generated.ts:1232](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1232)

***

### ability\_ids?

> `optional` **ability\_ids?**: `string`[]

Defined in: [generated.ts:1233](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1233)

***

### transport\_capacity?

> `optional` **transport\_capacity?**: \{ `capacity`: `number`; `keyword_restrictions?`: [`KeywordList`](../type-aliases/KeywordList.md) \| `null`; `exclusion_keywords?`: [`KeywordList`](../type-aliases/KeywordList.md) \| `null`; \} \| `null`

Defined in: [generated.ts:1234](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1234)

***

### game\_version

> **game\_version**: [`GameVersionReference`](GameVersionReference.md)

Defined in: [generated.ts:1239](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1239)

***

### is\_legend?

> `optional` **is\_legend?**: `boolean`

Defined in: [generated.ts:1240](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1240)
