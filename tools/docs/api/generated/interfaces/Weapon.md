[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [generated](../README.md) / Weapon

# Interface: Weapon

Defined in: [generated.ts:1329](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1329)

A weapon entry with one or more stat profiles (e.g., standard and overcharge modes).

This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
via the `definition` "weapon".

## Properties

### id

> **id**: `string`

Defined in: [generated.ts:1330](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1330)

***
### external\_refs?

> `optional` **external\_refs?**: [`ExternalReferenceList`](../type-aliases/ExternalReferenceList.md)

Defined in: [generated.ts:2722](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/generated.ts#L2722)

***


### name

> **name**: `string`

Defined in: [generated.ts:1331](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1331)

***

### type

> **type**: `"ranged"` \| `"melee"`

Defined in: [generated.ts:1332](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1332)

***

### profiles

> **profiles**: \[\{ `name`: `string`; `range?`: `number` \| `"Melee"`; `stats`: \{\[`k`: `string`\]: `unknown`; `A`: [`StatValue`](../type-aliases/StatValue.md); `BS?`: `number` \| `null`; `WS?`: `number` \| `null`; `S`: [`StatValue`](../type-aliases/StatValue.md); `AP`: `number`; `D`: [`StatValue`](../type-aliases/StatValue.md); \}; `keywords?`: `object`[]; \}, ...\{ name: string; range?: number \| "Melee"; stats: \{ A: StatValue; BS?: number \| null; WS?: number \| null; S: StatValue; AP: number; D: StatValue; \[k: string\]: unknown \}; keywords?: \{ keyword\_id: string; parameters?: \{ value?: StatValue; target\_keyword?: string; threshold?: number \} \}\[\] \}\[\]\]

Defined in: [generated.ts:1336](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1336)

#### Min Items

1

***

### game\_version

> **game\_version**: [`GameVersionReference`](GameVersionReference.md)

Defined in: [generated.ts:1392](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L1392)
