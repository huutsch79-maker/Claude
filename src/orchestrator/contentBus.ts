import type { DomainId } from "../config/domains.js";
import { assertDomainContentSummaryShape, type DomainContentSummary } from "./domainContentSummary.js";

/**
 * The domain-content counterpart of OperationalBus (see operationalBus.ts) —
 * same shape, same guarantee: every publish is shape-validated so this bus
 * physically cannot carry raw mail content, credentials, or free text, only
 * the whitelisted DomainContentSummary fields.
 */
export class ContentBus {
  private readonly latest = new Map<DomainId, DomainContentSummary>();
  private readonly listeners = new Set<(c: DomainContentSummary) => void>();

  publish(content: DomainContentSummary): void {
    assertDomainContentSummaryShape(content);
    this.latest.set(content.domain, content);
    for (const listener of this.listeners) listener(content);
  }

  onPublish(listener: (c: DomainContentSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ReadonlyMap<DomainId, DomainContentSummary> {
    return this.latest;
  }
}
