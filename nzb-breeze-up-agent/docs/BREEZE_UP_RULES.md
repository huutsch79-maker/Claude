# NZB Breeze Up Schedule: rules and how to read the output

*Knowledge file for NZB Breeze Up Agent. Upload it to the agent's Knowledge.*

## Purpose
Program the heats on each breeze-up day so jockeys have time to return for their
next rides, while keeping each preparer's draft together and as close as possible
to the preferred order.

## Glossary
- **Preparer**: the person or business presenting the horses (column *Preparer Name*).
  Scheduling is done by preparer.
- **Vendor / Draft**: the selling entity. One preparer can present several vendors' horses.
- **Lot**: the horse's catalogue number.
- **BUO (breeze-up order)**: the order a preparer wants to present their horses.
  Two horses with the same BUO breeze together in one heat (e.g. 1,1 = first heat,
  2,2 = second heat). A BUO with one horse is a single-horse heat. BUO numbers can
  continue from Monday into Tuesday for the same preparer. Only their order matters.
- **PO (preferred order)**: the order preparers would like to go in, from the
  *Mon Order* / *Tue Order* sheets.
- **Heat**: one breeze, usually two horses, numbered through the day.
- **Clash**: a jockey riding again with fewer than 4 heats in between.
- **Preparers breezing at once (lanes)**: how many preparers are in the rotation at
  the same time. With 5 at once, a preparer goes every 5th heat, so a jockey who
  rides every heat for that preparer automatically gets 4 heats between rides.

## Rules (priority order)
1. **At least 4 heats between each jockey's rides.** This includes jockeys booked
   by several preparers, whose other preparers' jockeys are also shared.
2. **Preparers breeze in succession.** A preparer's horses go in one continuous
   stretch (rotating with the other preparers in that window), never spread over
   the day, because preparers arrive with all their horses and stalls must be
   vacated for those arriving later.
3. **Preferred order.** Preparers start as close to the PO as the jockeys allow.
   The PO can be changed to accommodate jockeys.
4. **BUO kept** within each preparer, with only small swaps when needed to avoid a clash.
5. **Special circumstances** come from the *Agent Config* sheet. For 26RTR: Prima Park
   on Monday has four jockeys, so it sends 2 of its heats consecutively. Check
   this every sale.

## Rule priority (agreed with NZB)
1. **Jockeys: never fewer than 4 heats between a jockey's rides.** A jockey may ride
   for several preparers, but always with at least 4 heats in between. This is never
   broken.
2. **Preparers: 4 to 8 heats between two heats of the same preparer**, so preparers
   breeze in succession (they arrive with all their horses; stalls must be freed for
   later arrivals). Never fewer than 4. More than 8 only where rule 1 makes it
   unavoidable with the bookings; those heats are flagged **PREP GAP** and the
   "Preparer gap" column shows the gap before every heat. Prima Park on Monday sends
   back-to-back pairs.
3. Preferred order (Order sheets) and BUO order (moves of at most 2 places).
4. Shorter jockey waits.

If preparers should come first instead (gap 4 to 8 always, jockey clashes allowed
and flagged CLASH), ask the agent for "preparers first".

Where both rules collide, the fix is in the bookings or the order: for 26RTR Tuesday
Ryan Elliot rides for five preparers that are on course together, and Jasmine
Fawcett rides all of Kit Brooks' and most of Kilgravin's heats. Changing a few riders
or moving Kilgravin after Kit Brooks in the Tue Order removes most PREP GAP flags.

## How the draft is built
The scheduler uses the same "rolling wave" pattern as the 25RTR final programme.
About 5 preparers rotate one heat each. When one finishes, the next preparer in
the preferred order joins. A computer search then tries many variations and keeps
the one with no clashes, the tightest preparer groups, the closest-to-preferred
order and the fewest BUO changes. If no clash-free order exists with 5 at once,
it tries 6, then 7, and so on.

## Output sheets (prefixed with the sale code, e.g. "26RTR Mon Schedule")
| Sheet | What it shows |
|---|---|
| Summary | Heats, horses, clashes and preparers at once for each day, plus the data issue count |
| Mon / Tue Schedule | One row per horse: heat, preparer, vendor, BUO, lot, breeding, jockey, colours, the jockey's previous heat, heats between, and a check (OK / CLASH / First ride / No jockey) |
| Mon / Tue Programme | The same order in last year's programme layout (horse line, then jockey line) |
| Mon / Tue Preparers | Each preparer's preferred vs actual position, first and last heat, span, and BUO changes |
| Mon / Tue Jockeys | Each jockey's rides, the heats they ride, and the smallest gap |
| Options | The best result at each "preparers at once" width, to compare clash-free against tighter grouping |
| Clashes | Any rides with fewer than 4 heats between them |
| Validation | Data problems: ERROR = fix before publishing, WARNING = check, INFO = for awareness |
| Agent Config (used) | The exact settings the run used |

## Jockey waiting
Besides the hard rule (at least 4 heats between rides), the scheduler also tries to
avoid **long waits**: more than 15 heats between two rides of the same jockey.
The **Mon/Tue Jockeys** sheets show each jockey's first and last heat, longest wait,
and number of long waits. Named priority jockeys (setting PRIO) get the shortest
waits possible, at some cost to other jockeys. Much of the waiting comes from
bookings: a jockey riding for preparers far apart in the order, or rides spread
through one preparer's BUO order. Grouping a jockey's rides next to each other in
the BUO helps most.

## Validation codes
- **DUPLICATE_LOT**: the same lot appears twice on a day.
- **LOT_ON_TWO_DAYS**: a lot is on both the Monday and Tuesday lists.
- **DAY_MISMATCH**: the Day column doesn't match the sheet the horse is on.
- **PREPARER_NOT_IN_ORDER**: a preparer has horses but isn't on the order sheet.
  They are scheduled last. Add them to the order sheet, or add a *preparerAlias*.
- **HEAT_COUNT_MISMATCH**: the order sheet's *Heats* number differs from the horse list.
- **JOCKEY_SPELLING / JOCKEY_SIMILAR**: name variants. Add a *jockeyAlias* if they are the same person.
- **JOCKEY_OVERBOOKED**: a jockey has more rides than the day can fit with 4 heats
  between, so clashes are unavoidable. Talk to the preparers about bookings.
- **JOCKEY_HEAVY**: a jockey's workload nearly fills the day, and this jockey shapes the order.
- **NO_JOCKEY**: no rider booked. That horse is ignored for clash checks.
- **CLASHES_REMAIN / CLASH_FREE**: the final result for the day.

## Using the agent
1. Open NZB Breeze Up Agent in Teams, attach the sale's Heat Schedule workbook
   (sheets `Mon`, `Tue`, `Mon Order`, `Tue Order`) and ask it to build the schedule.
   Columns are found by header name, so their order doesn't matter. New
   preparers, vendors, jockeys and any number of lots are handled automatically.
   The jockey rides file isn't needed.
2. About a minute later the agent replies in the same chat with a summary and a
   temporary **Download** link (valid for 7 days) to your workbook with the draft
   sheets added.
3. Fix any ERROR lines in your own workbook and upload it again. Ask for "another
   version" or "7 preparers at once" to compare options.

## Setting up a new sale (agent owner)
Update the shared `Breeze Up Agent/Agent Config.xlsx` (in the agent's service account OneDrive): change
`saleCode`, check the `consecutive` rules (e.g. Prima Park | Mon | 2), and remove
old aliases. A workbook's own `Agent Config` sheet overrides the shared file for
that run.
