import type { SyncElement } from "./types";

/**
 * Excalidraw's convergence rule. Determines whether `incoming` should replace
 * `existing`. Both the Durable Object and the browser client call this so every
 * participant deterministically lands on the same scene regardless of message order.
 *
 * Incoming wins iff:
 *   - it has a strictly higher version, OR
 *   - versions tie AND it has a strictly LOWER versionNonce (order-independent tiebreak).
 *
 * If `existing` is undefined (element unseen), incoming always wins.
 */
export function shouldReplace(
  existing: Pick<SyncElement, "version" | "versionNonce"> | undefined,
  incoming: Pick<SyncElement, "version" | "versionNonce">
): boolean {
  if (!existing) return true;
  if (incoming.version > existing.version) return true;
  if (incoming.version < existing.version) return false;
  return incoming.versionNonce < existing.versionNonce;
}

/**
 * Merge `incoming` elements into a map keyed by id, applying `shouldReplace`.
 * Returns the elements that were actually accepted (i.e. changed the map) so the
 * caller can broadcast only the effective delta.
 */
export function reconcileInto(
  current: Map<string, SyncElement>,
  incoming: SyncElement[]
): SyncElement[] {
  const accepted: SyncElement[] = [];
  for (const el of incoming) {
    if (!el || typeof el.id !== "string") continue;
    if (shouldReplace(current.get(el.id), el)) {
      current.set(el.id, el);
      accepted.push(el);
    }
  }
  return accepted;
}
