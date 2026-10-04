# NZB Breeze Up Agent

Builds NZB breeze-up heat schedules:
- at least 4 heats between each jockey's rides;
- each preparer's horses kept together in one stretch, close to the preferred order;
- special rules (e.g. Prima Park sends 2 heats back-to-back) honoured;
- data problems flagged.

Staff upload the sale's Heat Schedule workbook into the **NZB Breeze Up Agent**
Copilot chat and get the draft schedule back as a download. No OneDrive,
SharePoint or flows are involved. The agent's instructions contain a compact
Python scheduler (`copilot/breeze_up_scheduler.py`), which Copilot's code
interpreter runs on the upload.

The TypeScript engine in `src/` is the fuller reference implementation. It is used
for local runs and tests, and by the fallback build in
`docs/ALTERNATIVE_FLOW_SETUP.md` (Office Script + agent flow).

| Read this | For |
|---|---|
| [docs/COPILOT_STUDIO_SETUP.md](docs/COPILOT_STUDIO_SETUP.md) | Step-by-step build of the agent (code interpreter, about 30 minutes) |
| [docs/ALTERNATIVE_FLOW_SETUP.md](docs/ALTERNATIVE_FLOW_SETUP.md) | Fallback build: Office Script + agent flow + OneDrive work folder |
| [docs/SOLUTION_ARCHITECTURE.md](docs/SOLUTION_ARCHITECTURE.md) | Design, algorithm, future-proofing, 26RTR data review |
| [docs/AGENT_INSTRUCTIONS.md](docs/AGENT_INSTRUCTIONS.md) | Text to paste into Copilot Studio, including the scheduler code |
| [docs/BREEZE_UP_RULES.md](docs/BREEZE_UP_RULES.md) | Knowledge file: rules, glossary, output sheets |

## Developer quick start

```bash
cd nzb-breeze-up-agent
npm install
npm test                       # synthetic sales, incl. new vendors / 3rd day / renamed columns
npm run typecheck              # Node code + the bundled Office Script
npm run schedule -- "26RTR_Heat_Schedule.xlsx" --config config/rtr26.config.json --out output/26RTR_draft.xlsx
npm run build:office           # regenerate dist-office/NZB_Breeze_Up_Agent.ts after changing src/

# compact Python version (what Copilot runs):
cp "26RTR_Heat_Schedule.xlsx" INPUT.xlsx && python3 copilot/breeze_up_scheduler.py   # needs openpyxl
```

After editing `copilot/breeze_up_scheduler.py`, regenerate the paste-in text with
`python3 scripts/build-agent-instructions.py`. It must stay under 8,000 characters.

Optional flags for `schedule`: `--day Mon` schedules one day only. `--config-text config/rtr26.agent-config.txt` uses the shared Agent Config text format, the same way the agent flow does. `--budget 45` sets a time budget in seconds, as the agent flow does.

Settings precedence: built-in defaults < `--config` JSON < shared config text
(`--config-text` / SharePoint Agent Config) < the workbook's **Agent Config** sheet
< run-time parameters (`preferLanes`, `seed`, `onlyDay`).

Sale workbooks are not committed. `*.xlsx` and `output/` are git-ignored, so
lot, jockey and preparer data stays in SharePoint.
