# NZB Breeze Up Agent: solution architecture and data review

## 1. Problem in one paragraph
For each breeze-up day, turn a list of horses (grouped by preparer and BUO into
heats) into one ordered programme where:
- **(hard)** every jockey has at least 4 heats between rides;
- each preparer's heats run as one continuous stretch, so they arrive, breeze
  and vacate stalls;
- preparers start close to the preferred order;
- BUO order is kept within each preparer;
- special rules such as *Prima Park sends 2 heats back-to-back* are honoured.

For 26RTR that is **109 heats (206 horses, 17 preparers, 31 jockeys) on Monday**
and **114 heats (216 horses, 28 preparers, 30 jockeys) on Tuesday**.

## 2a. Current design (chosen): Copilot code interpreter, no storage

James uploads the workbook into the Copilot chat. The agent's instructions contain
a compact, deterministic Python scheduler (`copilot/breeze_up_scheduler.py`, about
4.6k characters). Copilot Studio's **code interpreter** runs it in its sandbox and
returns `NZB_Breeze_Up_Schedule.xlsx` as a download. There is no OneDrive,
SharePoint, flow, connector or Azure. The algorithm is the same rolling-wave
greedy + simulated annealing as the TypeScript engine, but compact:
consecutive-rule preparers (Prima Park) are handled as fixed back-to-back blocks,
there are 3 annealing restarts, and the escalation runs from 5 to 8 preparers at
once. 26RTR result: 0 clashes on both days in about 17 seconds.

Trade-offs: code interpreter is a preview feature, and the agent must run the
provided code verbatim (the instructions say so explicitly; check the activity
map when testing). Sale rules are edited in the instructions' settings lines. The
section below describes the fuller Office Script design, kept as a fallback in
`ALTERNATIVE_FLOW_SETUP.md`.

## 2. Key design decision: deterministic solver, AI front door

| Option | Verdict |
|---|---|
| Ask the Copilot model to order the heats | ✗ It can't reliably check thousands of jockey-gap combinations. Results change run to run and can't be audited. |
| Excel formulas / macros | ✗ Last year's workbook already shows `#N/A` / `#REF!` chains. VBA can't run in Power Automate or Excel for the web. |
| **Office Script (TypeScript) solver + Copilot Studio agent** | ✓ Runs inside the workbook in Microsoft 365. No extra Azure cost. Same answer every time for the same inputs and seed. Testable. The agent handles language, explanations and Q&A. |
| Azure Function (Python/TS) + agent | Good later if the logic grows (e.g. stabling, timing, multi-sale). The same `core.ts` runs there unchanged. |

```
┌────────────── Microsoft 365 ────────────────────────────────────────────┐
│ James in Teams / M365 Copilot: 📎 <SALE>_Heat_Schedule.xlsx              │
│        ▼                                    ▲ summary + Download link    │
│ NZB Breeze Up Agent (Copilot Studio)        │ (same chat, ~1 minute)     │
│   topic "Build schedule from uploaded file" ┘                            │
│        ▼ file (waits ≤100 s)                                             │
│ Agent flow "Build Breeze Up Schedule"                                    │
│   ├─ Create file → service account OneDrive › Breeze Up Agent › Runs     │
│   ├─ List rows  ← Breeze Up Agent › Agent Config.xlsx (ConfigTable)      │
│   ├─ Run script (timeBudgetSeconds 45 → returns best found in time)      │
│   ├─ Create share link (organisation, view)                              │
│   ├─ Respond to agent (summary, errors, open + download links)           │
│   └─ Delay 7 days → Delete file   (link becomes invalid)                 │
└──────────────────────────────────────────────────────────────────────────┘
```

Everything the user sees happens in the Copilot chat. The OneDrive work folder is
a temporary workspace that Office Scripts needs, because scripts can only run on
workbooks stored in OneDrive or SharePoint.

**Settings come from three places** (later wins): built-in defaults < shared
`Agent Config.xlsx` in SharePoint (sale rules, maintained once per sale) < an
`Agent Config` sheet in the uploaded workbook (one-off overrides) < what the user
asks in chat (preparers at once, version/seed, single day).

**Same engine in three hosts.** `src/core.ts` has no imports and no host APIs.
It runs as:
1. the Office Script, which `npm run build:office` bundles with `src/office/main.ts`;
2. the Node command line (`npm run schedule -- file.xlsx`), for testing and
   offline use;
3. any future host, such as an Azure Function, Power Apps or another AI platform.

If Microsoft changes Copilot Studio, or NZB moves to another assistant, only the
thin front door changes. The scheduling rules and their tests stay.

## 3. Algorithm
1. **Parse by header name**, not column position. Column names, aliases and
   `noJockeyTokens` are all configurable.
2. **Validate** (see section 5) and write every finding to *Validation*.
3. **Group into heats** by (preparer, BUO), and sort each preparer's heats by BUO.
4. **Rolling-wave construction (greedy).** Up to *L* preparers are active. On
   each turn, the preparer that has waited longest sends its next clean heat
   (one with no jockey inside the 4-heat window), or its next 2 for a
   consecutive-rule preparer. When a preparer finishes, the next in the preferred
   queue joins. Hundreds of randomised variants are tried, with the preferred
   order perturbed by up to `orderFlex` places and BUO swaps of up to
   `maxBuoShift`.
5. **Simulated annealing** polishes the best variants. It swaps or moves heats
   within one rotation and minimises one weighted score:

   `clashes ≫ BUO beyond the cap > preparer idle waits ≈ broken consecutive turns > preferred-order deviation > too many preparers open > BUO moves > spread`
6. **Escalation ladder.** Try *L* = 5 first (tightest grouping), and only widen to
   6, 7 or 8 if clashes remain. Every width's best result is reported on the
   *Options* sheet, so a person can pick "1 clash, tighter" over "0 clashes,
   more spread".
7. **Deterministic.** A fixed `seed` gives the same result. Changing the seed
   gives an alternative, equally good draft.

### Results on 26RTR data (`config/rtr26.config.json`)
| Day | Heats | Clashes | Preparers at once | Longest wait within a preparer |
|---|---|---|---|---|
| Mon | 109 | **0** | 5 | 17 heats |
| Tue | 114 | **0** | 8 (7 gives 1 clash) | 24 heats |

For comparison, last year's (25RTR) final Monday programme had **15 rides with
fewer than 4 heats between them**.

## 4. Future-proofing
| Change next year | How it's handled |
|---|---|
| New or removed preparers or vendors | Read from the sheets every run. A preparer missing from the order sheet is flagged and scheduled last. |
| More or fewer lots or heats | No fixed sizes anywhere. Validation checks each jockey's workload against the day length. |
| New jockeys, name variants | Matching ignores case and spacing. Near-duplicates are flagged. Add a `jockeyAlias` row to merge them. |
| A third breeze-up day | Add a `day` row in *Agent Config* (`Wed \| Wed \| Wed Order`). |
| Gap rule changes (e.g. 5 heats) | `minHeatsBetween` in *Agent Config*. |
| New special case ("X sends 3 in a row") | A `consecutive` row in *Agent Config*. |
| Columns renamed or reordered | Header aliases (`Jockey`, `Jockey #1`, `Rider`…). Extend them in `defaultConfig().columns`. |
| Bigger sale, longer solve | `timeBudgetSeconds` stops the search in time and returns the best schedule found, so the reply still fits Copilot's 100-second limit. Run per day (`OnlyDay`) for more search time per day. |
| New AI platform or Copilot changes | `core.ts` is host-independent. Rebuild only the front door. |
| Staff turnover | Script and flow are team-owned in SharePoint and in a Power Platform solution. Docs are in this repository. |

## 5. Data review of the 26RTR files (findings to action)

| # | Finding | Impact | Action |
|---|---|---|---|
| 1 | **Lot 349 appears twice on Monday** (Riverrock Farm, rows 179 & 181, jockeys *Wiremu pinn* / *Chad Ormsby*) | One horse would breeze twice, or one horse is mis-keyed | Correct the lot number. *(ERROR in Validation)* |
| 2 | **Lot 284 is on Monday (Riverrock Farm, Hyeontaek Oh) and Tuesday (Mark Brooks / Alex Olivera, Jasmine Fawcett)**. The Jockeys file has the jockeys the other way round for this lot | Wrong horse or jockey in one file | Confirm the correct lot and day. *(ERROR)* |
| 3 | Tuesday rows 202–203 (Riversley Park, lots 207 & 359) have **Day = "Mon"** | Possibly in the wrong day's list | Confirm. *(WARNING)* |
| 4 | Preparer **"Mark Brooks / Alex Olivera"** (1 heat, BUO 5) isn't on *Tue Order*. Tue Order lists Mark Brooks with 5 heats | It would be scheduled last instead of with Mark Brooks | Added as a `preparerAlias`. Better: standardise the name at entry |
| 5 | **"Wiremu Pinn" / "Wiremu pinn"** | Treated as two jockeys in a pivot | Handled automatically. Standardise at entry |
| 6 | **9 horses with "No Jockey"** (Mon 2, Tue 7, including all 3 of Ryan Foote's Tuesday heats) | Clash check can't protect a rider booked later | Book riders, then re-run |
| 7 | Headers differ between sheets (*Jockey #1* on Mon, *Jockey* on Tue). Colours sit in an **unlabelled column** | Fragile for formulas and lookups | Handled by header aliases. Recommend a standard template with a *Colours* header |
| 8 | Order sheets' *Vendor/Draft Name* doesn't always match the horse list (e.g. BMD Bloodstock Ltd. → "Mapperley Stud" vs "BMD Bloodstock"). Preparer names have inconsistent case (*Regal farm*, *Fraser auret*, *richard otto*) | Matching on vendor would fail | Matching is on preparer name, ignoring case. Recommend a preparer master list |
| 9 | BUO numbers continue across days for some preparers (Kiltannon 8–13, Kit Brooks 8–14, Richard Otto 6–11 on Tue) | None. Only relative order is used | Documented |
| 10 | *Jockeys_Rides.xlsx → Riders* mixes per-preparer and per-jockey totals (e.g. Courtney Barnes: Count 1, Mon 6) and is a manual copy | Error-prone second source of truth | **Retire as an input.** The agent derives jockey loads from the Heat Schedule and outputs a *Jockeys* sheet |
| 11 | Heavy jockeys: **Troy Harris 20 rides in 109 Monday heats** (needs ≥ 96), Ryan Elliot 18–19, George Rooke 17–18, Sam Collett 17 on Tuesday | These riders shape the whole day | Flagged as JOCKEY_HEAVY. Share with preparers early |
| 12 | Last year's example workbook has `#N/A` / `#REF!` in the Tuesday, Stabling and Schedule_Tuesday sheets | Broken lookup chains | Outputs are now values written by the script, not formula chains |
| 13 | Working files are on `S:\SALES\…` | Cloud services (Office Scripts, Copilot, Power Automate) can't reach network drives | Upload to the agent in the Copilot chat. Each run is a temporary copy in the agent's OneDrive work folder, deleted after 7 days |
| 14 | Name spellings drift across years (*Ryan Elliott* in 25RTR, *Ryan Elliot* in 26RTR; *S Collett* vs *Sam Collett*) | History and analytics get split | Keep a jockey master list (a SharePoint list), and later feed aliases from it |

## 6. Roadmap (optional next steps)
1. **Jockey and preparer master lists** in SharePoint, with aliases read
   automatically.
2. **Stabling and boxing**: the 25RTR workbook has stabling sheets. Add stall
   allocation from heat order, so stalls free up in arrival order.
3. **Heat times**: set `startTime` and `minutesPerHeat` to print a Time column.
4. **Lock and edit**: let staff pin some heats (e.g. "Riversley must start at
   heat 1"), then re-optimise the rest.
5. **Publish step**: a second flow that exports the approved *Programme* sheets
   to PDF for the catalogue or website.

## 7. Repository layout
```
nzb-breeze-up-agent/
  src/core.ts            engine: parsing, validation, scheduler, output tables (host-independent)
  src/cli.ts             Node runner (xlsx in → draft xlsx out)
  src/office/main.ts     Office Script entry point (Excel / Power Automate)
  dist-office/NZB_Breeze_Up_Agent.ts   generated single-file Office Script to paste into Excel
  config/rtr26.config.json             26RTR settings for the CLI (JSON)
  config/rtr26.agent-config.txt        same, in the shared Agent Config text format
  templates/Agent_Config.xlsx          shared Agent Config file to put in SharePoint (table ConfigTable)
  test/                  vitest suite, including synthetic "next year" sales
  docs/                  setup guide, agent instructions, rules (knowledge), this document
```
