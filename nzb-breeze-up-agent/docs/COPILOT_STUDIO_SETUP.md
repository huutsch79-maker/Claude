# NZB Breeze Up Agent: step-by-step build in Copilot Studio

**No OneDrive. No SharePoint. No flows. No tools to add.**

James uploads the Heat Schedule workbook straight into the Copilot chat. The agent
runs the scheduler with Copilot's built-in **code interpreter** (a Python sandbox
inside Copilot) and hands back **`NZB_Breeze_Up_Schedule.xlsx` as a download** in
the same chat.

```
James: 📎 26RTR_Heat_Schedule.xlsx  "Build the breeze up schedule"
   ▼
NZB Breeze Up Agent (Copilot Studio)
   └─ code interpreter runs the scheduler code that's in the agent's instructions
   ▼
Agent: "Mon: 109 heats, 0 jockey clashes … Tue: 114 heats, 0 jockey clashes …"
       ⬇ NZB_Breeze_Up_Schedule.xlsx   (download in the chat)
```

The output workbook contains all of James's original sheets plus:
- **Mon Schedule** / **Tue Schedule**: heat order, preparer, vendor, BUO, lot,
  breeding, jockey, heats since the jockey's last ride, and OK / CLASH;
- **Mon Jockeys** / **Tue Jockeys**: each jockey's rides, first and last heat,
  longest wait, and number of waits over 15 heats (longest day first);
- **Validation**: the summary, duplicate lots, Day-column mismatches, preparers
  missing from the order sheet, horses with no jockey, and each preparer's heat range.

Tested on the 26RTR data: **Mon 109 heats and Tue 114 heats, both with 0 jockey
clashes**. Prima Park's Monday heats always go out in back-to-back pairs, BUO
moves are at most 2 places, and a run takes about 15–20 seconds.

Time to build: about 30 minutes.

---

## Step 1: Check you have what's needed (2 minutes)

- You can sign in to <https://copilotstudio.microsoft.com> (Copilot Studio licence
  or pay-as-you-go environment).
- Code interpreter is available in your environment. It's currently a **preview**
  feature in Copilot Studio, so if you don't see the toggle in Step 3, ask your
  Power Platform admin to allow preview features.
- Code interpreter uses Copilot credits (premium "text and generative AI tools").

## Step 2: Create the agent (5 minutes)

1. Open Copilot Studio and choose your environment (top right).
2. Select **Agents** → **+ New agent** → **Skip to configure**.
3. **Name:** `NZB Breeze Up Agent`
4. **Description:** *Upload the breeze-up Heat Schedule workbook and get back a
   draft heat order as a download. Jockeys get at least 4 heats between rides,
   each preparer's horses stay together, and data problems are flagged.*
5. **Instructions:** open `docs/AGENT_INSTRUCTIONS.md`, copy **everything inside
   the box** (the rules and the Python code), and paste it in.
6. Select **Create**.

## Step 3: Turn on file upload and code interpreter (2 minutes)

1. Select **Settings** (top right) → **Generative AI**.
2. Orchestration: **Generative**.
3. Under **File processing capabilities**:
   - **File uploads → On** (James can attach the workbook)
   - **Code interpreter → On** (runs the Python scheduler and creates the download)
4. Select **Save**.
5. **Settings → Security → Authentication:** keep **Authenticate with Microsoft**.
   Code interpreter needs signed-in users.

## Step 4: Tools and knowledge (nothing to add)

- **Tools: none.** Code interpreter is a built-in capability, not a tool.
- **Knowledge: optional.** The rules are already in the instructions. If you want
  extra "why" answers, upload `docs/BREEZE_UP_RULES.md` under **Knowledge → Add
  knowledge → Files**. Uploaded knowledge files are stored inside Copilot Studio
  itself, not in OneDrive or SharePoint.
- Turn off "Allow the AI to use its own general knowledge" so answers stay on topic.

## Step 5: Test in the test panel (10 minutes)

1. In **Test your agent**, click the **📎** icon and attach `26RTR_Heat_Schedule.xlsx`.
2. Type: **Build the breeze up schedule from this file**
3. Expect, after about 20–40 seconds:
   - `Mon: 109 heats, 0 jockey clashes, 6 preparers breezing at once`
   - `Tue: 114 heats, 0 jockey clashes, 8 preparers breezing at once`
   - `ERROR lot 349 listed twice …` and `ERROR lot 284 listed twice …` (real
     data problems in the 26RTR file)
   - a download link for **NZB_Breeze_Up_Schedule.xlsx**
4. Download it and check the **Mon Schedule** sheet. Prima Park's Monday heats
   should come in pairs (with the standard settings: heats 10–11, 26–27, 36–37, 47–48, 62–63).
5. Follow-ups in the same chat:
   - **Redo it with 7 preparers at once**: the agent sets `LANES=[7]`.
   - **Give me another version**: the agent sets a new `SEED`.
   - **What does CLASH mean?**: answered from the rules.
   - **Keep Sam Collett's waits short**: the agent sets `PRIO=['Sam Collett']`.
6. Open the **activity map** (or the `</> Code` view) to confirm the agent ran the
   code from the instructions, not code it wrote itself. If it improvised, make
   the instruction "Use code interpreter to run the PYTHON CODE below EXACTLY"
   more prominent, and test again.

## Step 6: Publish for James (5 minutes)

1. Select **Publish** (top right) → **Publish**.
2. **Channels** → **Teams and Microsoft 365 Copilot** → **Add channel**. Keep
   *Make agent available in Microsoft 365 Copilot* ticked.
3. **Availability options → Show to my teammates and shared users** → add James
   (and the Sales team).
4. James: Teams → **Apps** → **Built with Power Platform** → **NZB Breeze Up
   Agent** → **Add**, then pin it.
5. Test once more **in Teams with James's account**. Upload, generate, and check
   the download appears. This is the one step that couldn't be checked from here.

**Suggested prompts** (agent Overview): *Build the breeze up schedule from this
file* · *Redo Tuesday with 7 preparers at once* · *Give me another version* ·
*Explain the Validation sheet*.

---

## Each new sale (2 minutes)

Open the agent → **Instructions** and edit only these lines near the top of the code:

| Line | Example | Meaning |
|---|---|---|
| `PAIRS=` | `{('prima park','mon'):2}` | preparer + day sending heats back-to-back (lower case). Use `{}` if none |
| `ALIAS=` | `{'mark brooks / alex olivera':'mark brooks'}` | merge name variants (lower case). Use `{}` if none |
| `GAP=` | `4` | heats between a jockey's rides |
| `WS=` | `150` | how strongly preparers are kept together in succession (higher = tighter, but jockeys may wait more) |
| `JPEN=` | `300` | how hard to cut long jockey waits (0 = off; higher = shorter waits, but preparers may spread more) |
| `PRIO=` | `['Sam Collett']` | jockeys whose waits are kept as short as possible (e.g. riding at the races that day). Use `[]` if none |

Then **Publish**. James can also say a change in chat for a single run, e.g.
*"This time Prima Park sends 2 in a row on Tuesday"*.

New preparers, vendors and jockeys, and any number of lots, need **no changes**:
everything is read from the uploaded workbook. Columns are found by header name
(`Preparer Name`, `BUO`, `Lot`, `Jockey` / `Jockey #1` / `Rider`,
`Vendor/Draft Name`, `Breeding`), so column order doesn't matter.

## What James's workbook must contain

- Sheets **Mon** and **Tue** with one row per horse: Preparer Name, BUO, Lot,
  Jockey (plus Vendor and Breeding if available).
- Sheets **Mon Order** and **Tue Order** with preparer names in the preferred
  order in the first column.
- A normal `.xlsx`, under 16 MB, with **no password or encrypting sensitivity
  label**.
- The jockey rides file is **not** needed.

## Things to know

- **Files stay in the chat session.** The download link is valid while the chat
  is open. Copilot doesn't keep the files afterwards, so James should save the
  download.
- **Preview feature.** Code interpreter in Copilot Studio is in preview, so test
  after Microsoft updates. If it's ever unavailable, the fallback build is in
  `ALTERNATIVE_FLOW_SETUP.md`. That one uses a temporary OneDrive work folder.
- **Run time** is about 15–40 seconds. If the chat ever times out, ask the agent
  to "use STEPS=6000" for that run.
- **It's a draft.** Someone should check it before the programme is published.
  The Validation sheet lists what to fix in the source workbook.
