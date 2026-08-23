import type { DomainId } from "../config/domains.js";
import { assertOperationalMetadataShape, type OperationalMetadata } from "./operationalMetadata.js";

/**
 * The single shared channel domain instances are allowed to publish to.
 * Every publish is shape-validated (see operationalMetadata.ts) so the bus
 * physically cannot carry request context, memory content, or credentials —
 * only the whitelisted health/expiry/error-count fields.
 */
export class OperationalBus {
  private readonly latest = new Map<DomainId, OperationalMetadata>();
  private readonly listeners = new Set<(m: OperationalMetadata) => void>();

  publish(metadata: OperationalMetadata): void {
    assertOperationalMetadataShape(metadata);
    this.latest.set(metadata.domain, metadata);
    for (const listener of this.listeners) listener(metadata);
  }

  onPublish(listener: (m: OperationalMetadata) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ReadonlyMap<DomainId, OperationalMetadata> {
    return this.latest;
  }
}
