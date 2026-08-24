# Migrations

A migration is a plain `.sql` file in this folder, applied once, in
filename order (so prefix with a zero-padded sequence number:
`0001_add_foo.sql`).

These are **not** run automatically. They're executed one at a time via
the `apply-migration` script (`src/core/scriptRegistry.ts`), which is
`requires_approval` tier — matching CLAUDE.md's "any structural/schema
change" rule. The script only accepts a filename that actually exists in
this folder at the time it's called; it never accepts or runs arbitrary
SQL text. Once a migration has been applied, `apply-migration` refuses to
run it again (tracked in `jarvis.applied_migrations`).

Nothing here yet — `db/schema.sql` still owns the baseline schema. Add
migrations here once the baseline needs to change without a full rebuild.
