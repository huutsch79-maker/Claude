/**
 * The full list of domains JARVIS knows about. Adding a domain means adding
 * one entry here plus one schema in db/schema.sql — nothing else in the
 * orchestrator or core modules should need to change (see docs/architecture.md,
 * "adding a third domain").
 */
export const DOMAIN_IDS = ["work", "personal"] as const;
export type DomainId = (typeof DOMAIN_IDS)[number];

export interface DomainConfig {
  id: DomainId;
  /** Postgres schema holding this domain's memory/relations/capabilities tables. */
  schema: string;
  /** Env var prefix this domain's credentials must live under (see credentialStore.ts). */
  credentialEnvPrefix: string;
  /** Human label, used only in logs/notifications — never in cross-domain payloads. */
  label: string;
  /**
   * Whether this domain has an Azure subscription behind it at all. A
   * structural fact, never data-driven: Domain.ts uses it to decide whether
   * to call the cost fetcher, and the dashboard uses it to decide whether a
   * cost panel exists for the domain. Declared here so both read one source
   * of truth — a domain without it can never surface an Azure figure, even
   * transiently while waiting for its first content report.
   */
  hasAzureCost: boolean;
}

export const DOMAINS: Record<DomainId, DomainConfig> = {
  work: {
    id: "work",
    schema: "work",
    credentialEnvPrefix: "JARVIS_WORK_",
    label: "NZB (work)",
    hasAzureCost: true,
  },
  personal: {
    id: "personal",
    schema: "personal",
    credentialEnvPrefix: "JARVIS_PERSONAL_",
    label: "Personal",
    hasAzureCost: false,
  },
};

export function isDomainId(value: string): value is DomainId {
  return (DOMAIN_IDS as readonly string[]).includes(value);
}
