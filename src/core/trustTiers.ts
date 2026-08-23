/**
 * The full list of self-heal action kinds and which trust tier they fall
 * into. This is the single source of truth for "auto-fix vs approval" —
 * see CLAUDE.md, "Self-heal trust tiers". Adding a new self-heal action
 * kind means adding one line here, and it defaults to REQUIRES_APPROVAL
 * unless explicitly listed as auto-fix (fail closed).
 */
export type TrustTier = "auto_fix" | "requires_approval";

export type SelfHealActionKind =
  // auto-fix: reversible, single-domain
  | "module_crash_restart"
  | "stale_cache_clear"
  | "high_confidence_duplicate_memory_cleanup"
  | "transient_api_retry"
  // requires approval: credentials, domain-boundary risk, structural/schema, module add/remove
  | "credential_rotation"
  | "credential_revocation"
  | "domain_boundary_change"
  | "schema_migration"
  | "module_add"
  | "module_remove";

const AUTO_FIX_KINDS: ReadonlySet<SelfHealActionKind> = new Set([
  "module_crash_restart",
  "stale_cache_clear",
  "high_confidence_duplicate_memory_cleanup",
  "transient_api_retry",
]);

export function classifyTrustTier(kind: SelfHealActionKind): TrustTier {
  return AUTO_FIX_KINDS.has(kind) ? "auto_fix" : "requires_approval";
}
