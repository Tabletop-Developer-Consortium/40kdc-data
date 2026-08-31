import type { ExternalReference } from "./generated.js";

/** An entity that may carry stable identities assigned by external sources. */
export interface ExternalReferenceCarrier {
  external_refs?: ExternalReference[];
}

/**
 * Attach one exact external identity, preserving local pair uniqueness and a
 * deterministic namespace/id order. Returns true only when the entity changed.
 */
export function addExternalRef(
  entity: ExternalReferenceCarrier,
  namespace: string,
  id: string,
): boolean {
  const refs = entity.external_refs ?? [];
  if (refs.some((ref) => ref.namespace === namespace && ref.id === id))
    return false;
  refs.push({ namespace, id });
  refs.sort(
    (left, right) =>
      left.namespace.localeCompare(right.namespace) ||
      left.id.localeCompare(right.id),
  );
  entity.external_refs = refs;
  return true;
}

/** Stable composite key used by collection external-reference indexes. */
export function externalRefKey(namespace: string, id: string): string {
  return `${namespace}\0${id}`;
}
