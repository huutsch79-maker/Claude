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
Agent: "Mon: 109 heats, 0 jockey clashes, 3 preparer gaps outside 4-8 … Tue: 114 heats, 0 jockey clashes, 0 preparer gaps …"
       ⬇ NZB_Breeze_Up_Schedule.xlsx   (download in the chat)
```

The output workbook contains all of James's original sheets plus:
- **Mon Schedule** / **Tue Schedule**: heat order, preparer, vendor, BUO, lot,
  breeding, jockey, heats since the jockey's last ride, the preparer gap, and a
  check: OK / CLASH / PREP GAP / BUO MOVE;
- **Mon Jockeys** / **Tue Jockeys**: each jockey's rides, first and last heat and
  longest wait (longest day first);
- **Validation**: the summary, duplicate lots, horses whose Day column doesn't
  match their sheet, preparers missing from the order sheet, and BUO or jockey
  problems in the data.

The scheduler needs only Python and NumPy, which Copilot's code interpreter has
(no extra packages). Tested on 26RTR, with every result checked by a separate
script: jockeys always have at least 4 heats between rides (0 clashes on both
days in almost every run). **Tuesday** usually meets every rule (0 preparer gaps
over 8, BUO moves of at most 2); when it does, the time left over is used to pull
preparers closer to the Order sheet. **Monday** typically has 2 to 7 preparer
gaps (mostly 9 heats), flagged PREP GAP. Each run differs; ask for "another
version" to try again, and keep the best.
Monday is the hard day: Troy Harris, George Rooke and Ryan Elliot have 18 to 20
rides each. Prima Park's Monday heats always go out in back-to-back pairs. A run
takes about 3 to 4 minutes for both days.

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
3. Expect, after about 3–4 minutes:
   - `Mon: 109 heats, 0 jockey clashes, 0-5 preparer gaps outside 4-8, 0 BUO moves over 2`
   - `Tue: 114 heats, 0 jockey clashes, 0 preparer gaps outside 4-8, 0 BUO moves over 2`
   - `ERROR lot 349 listed twice …` and `ERROR lot 284 listed twice …` (real
     data problems in the 26RTR file)
   - a download link for **NZB_Breeze_Up_Schedule.xlsx**
4. Download it and check the **Mon Schedule** sheet. Prima Park's Monday heats
   should come in pairs, and the Check column shows any PREP GAP heats.
5. Follow-ups in the same chat:
   - **Give me another version**: the agent sets a new `SEED`. Each run differs,
     so asking again can remove Monday's PREP GAP flags.
   - **Redo Monday with more time**: the agent sets `DAYS=['Mon']` and a higher `TL`.
   - **What does PREP GAP mean?**: answered from the rules.
6. Open the **activity map** (or the `</> Code` view) to confirm the agent ran the
   code from the instructions, not code it wrote itself. If it improvised, make
   the instruction "Use code interpreter to run the PYTHON CODE below EXACTLY"
   more prominent, and test again.

## Step 5a: Packages in Copilot's code interpreter (checked)

Copilot's code-interpreter sandbox has only **NumPy** (plus the Python standard
library and openpyxl for Excel). OR-Tools, SciPy, PuLP, HiGHS and networkx are
not there, and packages can't be installed. The scheduler above is written for
that. `docs/AGENT_INSTRUCTIONS_EXACT.md` (OR-Tools) is only for an environment
that has OR-Tools; don't use it in this Copilot.

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
file* · *Redo Monday with more time* · *Give me another version* ·
*Explain the Validation sheet*.

---

## Each new sale (2 minutes)

Open the agent → **Instructions** and edit only these lines near the top of the code:

| Line | Example | Meaning |
|---|---|---|
| `PAIRS=` | `{('prima park','mon'):2}` | preparer + day sending heats back-to-back (lower case). Use `{}` if none |
| `ALIAS=` | `{'mark brooks / alex olivera':'mark brooks'}` | merge name variants (lower case). Use `{}` if none |
| `GAP=` | `4` | heats between a jockey's rides |
| `VMIN=` / `VMAX=` | `4` / `8` | heats between two heats of the same preparer. Exceeded only where the search can't avoid it (flagged PREP GAP) |
| `SHIFT=` | `2` | how many places a heat may move from the preparer's BUO order |
| `TL=` | `120` | seconds of search per day. More time gives fewer PREP GAP flags |
| `SEED=` | `1` | change it for another version |

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
- **Run time** is about 3–4 minutes (2 minutes per day). If the chat ever times
  out, ask the agent to do one day at a time (`DAYS=['Mon']`, then `['Tue']`) or
  to "use TL=60".
- **It's a draft.** Someone should check it before the programme is published.
  The Validation sheet lists what to fix in the source workbook.
