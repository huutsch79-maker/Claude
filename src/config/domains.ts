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
}

export const DOMAINS: Record<DomainId, DomainConfig> = {
  work: {
    id: "work",
    schema: "work",
    credentialEnvPrefix: "JARVIS_WORK_",
    label: "NZB (work)",
  },
  personal: {
    id: "personal",
    schema: "personal",
    credentialEnvPrefix: "JARVIS_PERSONAL_",
    label: "Personal",
  },
};

export function isDomainId(value: string): value is DomainId {
  return (DOMAIN_IDS as readonly string[]).includes(value);
}
