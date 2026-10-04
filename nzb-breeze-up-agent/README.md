# NZB Breeze Up Agent

Builds NZB breeze-up heat schedules:
- at least 4 heats between each jockey's rides;
- each preparer's horses kept together in one stretch, close to the preferred order;
- special rules (e.g. Prima Park sends 2 heats back-to-back) honoured;
- data problems flagged.

It is used through a Copilot Studio agent in Teams. The solver itself is an Excel
Office Script.

| Read this | For |
|---|---|
| [docs/COPILOT_STUDIO_SETUP.md](docs/COPILOT_STUDIO_SETUP.md) | Step-by-step build of the Copilot agent, flow and script |
| [docs/SOLUTION_ARCHITECTURE.md](docs/SOLUTION_ARCHITECTURE.md) | Design, algorithm, future-proofing, 26RTR data review |
| [docs/AGENT_INSTRUCTIONS.md](docs/AGENT_INSTRUCTIONS.md) | Text to paste into Copilot Studio |
| [docs/BREEZE_UP_RULES.md](docs/BREEZE_UP_RULES.md) | Knowledge file: rules, glossary, output sheets |

## Developer quick start

```bash
cd nzb-breeze-up-agent
npm install
npm test                       # synthetic sales, incl. new vendors / 3rd day / renamed columns
npm run typecheck              # Node code + the bundled Office Script
npm run schedule -- "26RTR_Heat_Schedule.xlsx" --config config/rtr26.config.json --out output/26RTR_draft.xlsx
npm run build:office           # regenerate dist-office/NZB_Breeze_Up_Agent.ts after changing src/
```

Optional flags for `schedule`: `--day Mon` schedules one day only.

Settings precedence: built-in defaults < `--config` JSON < the workbook's
**Agent Config** sheet < run-time parameters (`preferLanes`, `seed`, `onlyDay`).

Sale workbooks are not committed. `*.xlsx` and `output/` are git-ignored, so
lot, jockey and preparer data stays in SharePoint.
