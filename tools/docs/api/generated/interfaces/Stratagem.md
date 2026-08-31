[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [generated](../README.md) / Stratagem

# Interface: Stratagem

Defined in: [generated.ts:882](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L882)

A CP-costed ability usable during specific game phases.

This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
via the `definition` "stratagem".

## Properties

### id

> **id**: `string`

Defined in: [generated.ts:883](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L883)

***
### external\_refs?

> `optional` **external\_refs?**: [`ExternalReferenceList`](../type-aliases/ExternalReferenceList.md)

Defined in: [generated.ts:2003](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/generated.ts#L2003)

***


### name

> **name**: `string`

Defined in: [generated.ts:884](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L884)

***

### category

> **category**: `"core"` \| `"detachment"`

Defined in: [generated.ts:888](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L888)

Whether this is a universal core stratagem or tied to a specific detachment

***

### type

> **type**: `"battle-tactic"` \| `"strategic-ploy"` \| `"epic-deed"` \| `"wargear"`

Defined in: [generated.ts:892](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L892)

GW-printed stratagem category from the card

***

### detachment\_id?

> `optional` **detachment\_id?**: `string` \| `null`

Defined in: [generated.ts:896](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L896)

Null for core stratagems

***

### cp\_cost

> **cp\_cost**: `number`

Defined in: [generated.ts:897](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L897)

***

### phases

> **phases**: [`PhaseList`](../type-aliases/PhaseList.md)

Defined in: [generated.ts:898](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L898)

***

### player\_turn

> **player\_turn**: [`PlayerTurn`](../type-aliases/PlayerTurn.md)

Defined in: [generated.ts:899](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L899)

***

### timing

> **timing**: `"once-per-phase"` \| `"once-per-turn"` \| `"once-per-battle"` \| `"unlimited"`

Defined in: [generated.ts:900](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L900)

***

### target\_restrictions?

> `optional` **target\_restrictions?**: \{ `required_keywords?`: [`KeywordList`](../type-aliases/KeywordList.md); `excluded_keywords?`: [`KeywordList`](../type-aliases/KeywordList.md); `notes?`: `string`; \} \| `null`

Defined in: [generated.ts:901](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L901)

***

### ability\_id?

> `optional` **ability\_id?**: `string` \| `null`

Defined in: [generated.ts:906](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L906)

***

### game\_version

> **game\_version**: [`GameVersionReference`](GameVersionReference.md)

Defined in: [generated.ts:907](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L907)
