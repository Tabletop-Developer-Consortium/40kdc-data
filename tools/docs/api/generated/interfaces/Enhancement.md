[**@alpaca-software/40kdc-data**](../../README.md)

***

[@alpaca-software/40kdc-data](../../README.md) / [generated](../README.md) / Enhancement

# Interface: Enhancement

Defined in: [generated.ts:349](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L349)

A purchasable upgrade for a character unit, provided by a detachment.

This interface was referenced by `0KdcBundledSchemas`'s JSON-Schema
via the `definition` "enhancement".

## Properties

### id

> **id**: `string`

Defined in: [generated.ts:350](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L350)

***
### external\_refs?

> `optional` **external\_refs?**: [`ExternalReferenceList`](../type-aliases/ExternalReferenceList.md)

Defined in: [generated.ts:897](https://github.com/wn-mitch/40kdc-data/blob/c9c88e6391023daf41c88513e9ecb21950c56b1c/tools/src/generated.ts#L897)

***


### name

> **name**: `string`

Defined in: [generated.ts:351](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L351)

***

### detachment\_id

> **detachment\_id**: `string`

Defined in: [generated.ts:352](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L352)

***

### cost

> **cost**: `number`

Defined in: [generated.ts:353](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L353)

***

### points\_provisional?

> `optional` **points\_provisional?**: `boolean`

Defined in: [generated.ts:357](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L357)

True when the cost is carried over provisionally (e.g. seeded from a prior edition during migration) and not yet confirmed against the current dataslate.

***

### upgrade\_tag?

> `optional` **upgrade\_tag?**: `boolean`

Defined in: [generated.ts:361](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L361)

11e: when true, this enhancement applies to up to `max_targets` non-character units while counting as a single Enhancement choice.

***

### max\_targets?

> `optional` **max\_targets?**: `number`

Defined in: [generated.ts:365](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L365)

Number of units this enhancement may be applied to. Only meaningful when `upgrade_tag` is true; defaults to 1.

***

### keyword\_restrictions?

> `optional` **keyword\_restrictions?**: [`KeywordList`](../type-aliases/KeywordList.md)

Defined in: [generated.ts:366](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L366)

***

### exclusion\_keywords?

> `optional` **exclusion\_keywords?**: [`KeywordList`](../type-aliases/KeywordList.md) \| `null`

Defined in: [generated.ts:367](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L367)

***

### ability\_id?

> `optional` **ability\_id?**: `string` \| `null`

Defined in: [generated.ts:368](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L368)

***

### is\_unique?

> `optional` **is\_unique?**: `boolean`

Defined in: [generated.ts:369](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L369)

***

### game\_version

> **game\_version**: [`GameVersionReference`](GameVersionReference.md)

Defined in: [generated.ts:370](https://github.com/wn-mitch/40kdc-data/blob/0b6959256a79cf859a201d8971874d4a811c6024/tools/src/generated.ts#L370)
