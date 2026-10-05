# NZB Breeze Up Agent: instructions to paste into Copilot Studio

Paste **everything inside the box below** into the agent's **Instructions** field
(Overview → Instructions → Edit). It contains the behaviour rules **and** the
scheduler code that Copilot's code interpreter runs. It is {{CHARS}} characters, under
Copilot Studio's 8,000-character limit.

It needs only Python and NumPy, which Copilot's code interpreter has. No extra
packages are needed.

Each new sale, change only the settings lines near the top of the code:
- `PAIRS` – preparers sending heats back-to-back, e.g. `{('prima park','mon'):2}`. Use `{}` if none
- `ALIAS` – name variants (lower case), e.g. `{'mark brooks / alex olivera':'mark brooks'}`. Use `{}` if none
- `GAP` – heats between a jockey's rides (4)
- `VMIN` / `VMAX` – heats between two heats of the same preparer (4 / 8)
- `SHIFT` – how many places a heat may move from the BUO order (2)
- `TL` – seconds of search per day (120). More time gives fewer flags
- `SEED` – change the number to get another version

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
- Redo Tuesday only
- Give me another version
- Explain the PREP GAP flags
