# NZB Breeze Up Agent: instructions to paste into Copilot Studio

Paste **everything inside the box below** into the agent's **Instructions** field
(Overview → Instructions → Edit). It contains the behaviour rules **and** the
scheduler code that Copilot's code interpreter runs. It is {{CHARS}} characters, under
Copilot Studio's 8,000-character limit.

Each new sale, change only the settings lines near the top of the code:
- `PAIRS` – preparers sending heats back-to-back, e.g. `{('prima park','mon'):2}`
- `ALIAS` – name variants (lower case), e.g. `{'mark brooks / alex olivera':'mark brooks'}`
- `GAP` – heats between a jockey's rides (4)
- `JPEN` – how hard to cut long jockey waits (300; 0 = off)
- `PRIO` – jockeys to keep waits short, e.g. `['Sam Collett']`

The text is close to the 8,000-character limit. Regenerate it with
`python3 scripts/build-agent-instructions.py` after any edit, so the length is checked.

~~~text
{{INSTRUCTIONS}}~~~

## Name
NZB Breeze Up Agent

## Description
Upload the breeze-up Heat Schedule workbook and get back a draft heat order as a
download. Jockeys get at least 4 heats between rides, each preparer's horses stay
together, and data problems are flagged.

## Suggested prompts
- Build the breeze up schedule from this file
- Redo Tuesday with 7 preparers at once
- Give me another version
- Explain the clashes in the Validation sheet
