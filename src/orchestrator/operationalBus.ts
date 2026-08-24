import { assertOperationalMetadataShape, type OperationalMetadata } from "./operationalMetadata.js";

/**
 * The channel health reports get published to. Every publish is
 * shape-validated (see operationalMetadata.ts) so it physically cannot
 * carry chat/memory content or credentials — only the whitelisted
 * health/expiry/error-count fields.
 */
export class OperationalBus {
  private latest: OperationalMetadata | null = null;
  private readonly listeners = new Set<(m: OperationalMetadata) => void>();

  publish(metadata: OperationalMetadata): void {
    assertOperationalMetadataShape(metadata);
    this.latest = metadata;
    for (const listener of this.listeners) listener(metadata);
  }

  onPublish(listener: (m: OperationalMetadata) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): OperationalMetadata | null {
    return this.latest;
  }
}
