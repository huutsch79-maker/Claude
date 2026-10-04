# NZB Breeze Up Agent: step-by-step build in Copilot Studio

This guide builds **NZB Breeze Up Agent**, a Copilot agent in Teams and
Microsoft 365 Copilot. Sales staff ask it something like *"Build the 26RTR
breeze up schedule"* and get back a draft heat programme in the sale's Heat
Schedule workbook. The draft has:

- at least 4 heats between each jockey's rides,
- each preparer's horses breezing in one continuous stretch, in an order close
  to the preferred order,
- Prima Park-style "two heats back-to-back" rules honoured,
- a validation sheet listing data problems to fix.

Time to build: about 2 to 3 hours the first time. After that, each sale needs
about 10 minutes of setup (see **Part 8**).

> **Why the agent doesn't plan the heats itself.** The scheduling is a puzzle
> with thousands of possible orders, and an AI chat model can't reliably check
> every jockey gap. So the solving is done by deterministic code (an Excel
> **Office Script**) that gives the same answer every time and can be checked.
> The Copilot agent is the friendly front door: it understands the request,
> runs the script, explains the result and answers questions.
> See `SOLUTION_ARCHITECTURE.md`.

```
 You (Teams / M365 Copilot)
        │  "Build the 27RTR breeze up schedule"
        ▼
 NZB Breeze Up Agent  (Copilot Studio)
        │  calls tool
        ▼
 Agent flow "Build Breeze Up Schedule"
        │  1. replies "started" to the agent straight away
        │  2. Run script from SharePoint library ──►  NZB_Breeze_Up_Agent script
        │                                             reads:  Mon, Tue, Mon Order, Tue Order, Agent Config
        │                                             writes: <sale> Mon Schedule, Programme, Jockeys,
        │                                                     Preparers, Options, Clashes, Validation
        ▼  3. Teams message to you with the summary and a link to the workbook
```

---

## Part 0: Prerequisites (do once, with IT if needed)

| Need | Why | Who |
|---|---|---|
| Copilot Studio access (licence or pay-as-you-go environment) | build the agent and agent flow | IT / Power Platform admin |
| Microsoft 365 business licence with **Office Scripts** enabled (Excel shows an **Automate** tab) | runs the scheduler inside Excel | IT (M365 admin centre → Org settings → Office Scripts) |
| A **SharePoint / Teams site** for Sales (e.g. *NZB Sales*) | Office Scripts and flows **can't** reach `S:\` network drives | IT / site owner |
| Power Platform policy allows the **Excel Online (Business)**, **SharePoint**, **Microsoft Teams** and **Office 365 Users** connectors together | the flow uses all four | Power Platform admin |
| Teams admin allows Power Platform apps | so staff can install the agent | Teams admin |

### 0.1 Move the breeze-up folder to SharePoint

Copy `S:\SALES\26RTR\26RTR Breezeups\Heat Schedule` into the SharePoint site,
using the **same folder pattern every sale**. For example:

```
NZB Sales (site) › Documents › Sales › 26RTR › Breezeups › Heat Schedule › 26RTR_Heat_Schedule.xlsx
NZB Sales (site) › Documents › Sales › 27RTR › Breezeups › Heat Schedule › 27RTR_Heat_Schedule.xlsx
```

The flow builds the path from the sale code, so keeping this pattern is what
lets next year's sale work without changing the flow. You can map the
SharePoint library to File Explorer (**Sync**) if people prefer working from a
drive letter.

Also create a folder for the script, e.g. `Documents › Breeze Up Agent › Scripts`.

---

## Part 1: Install the scheduler script in Excel (about 15 minutes)

1. Open `26RTR_Heat_Schedule.xlsx` **in Excel for the web** (from SharePoint).
2. Select **Automate** → **New Script** (or **Create in Code Editor**).
3. Delete the sample code. Open
   `nzb-breeze-up-agent/dist-office/NZB_Breeze_Up_Agent.ts` from this
   repository, copy **all** of it, and paste it into the Code Editor.
4. Click the script name at the top and rename it to **NZB Breeze Up Agent**.
   Select **Save script**.
5. **Make it team-owned.** Click the script name again, select **Move**, and
   choose `Documents › Breeze Up Agent › Scripts` in the SharePoint site. Scripts
   left in your personal OneDrive stop working if you leave or your account
   changes.
6. **Test it in Excel first, before any agent work:** select **Run**.
   - The first run creates an **Agent Config** sheet (see Part 7), then builds
     the schedule.
   - Expect 20–60 seconds. You'll get new sheets such as
     `26RTR Summary`, `26RTR Mon Schedule`, `26RTR Mon Programme`,
     `26RTR Options`, `26RTR Clashes` and `26RTR Validation`.
7. Open **Agent Config** and check the settings. For 26RTR, add these rows
   (columns **Setting | Value**):

   | Setting | Value |
   |---|---|
   | saleCode | 26RTR |
   | consecutive | Prima Park \| Mon \| 2 |
   | preparerAlias | Mark Brooks / Alex Olivera => Mark Brooks |

   Run the script again. You now have a working scheduler, even without the agent.

> The script can also be put on a button: **Automate** → script → **…** → **Add
> in workbook**. This is a useful fallback if Copilot is ever unavailable.

---

## Part 2: Create the agent (about 15 minutes)

1. Go to <https://copilotstudio.microsoft.com> and pick the right
   **environment** (top right). Use your organisation's production environment
   for Sales, not the personal default, if IT has set one up.
2. Select **Agents** → **+ New agent** (or **Create blank agent**). Choose
   **Skip to configure** if it offers a chat-based setup.
3. Fill in:
   - **Name:** `NZB Breeze Up Agent`
   - **Icon:** an NZB / horse icon (optional)
   - **Description:** *Builds and explains NZB breeze-up heat schedules. Orders
     heats so jockeys have at least 4 heats between rides, keeps each preparer's
     horses together and close to the preferred order, and flags data problems.*
4. **Instructions:** paste the full text from `docs/AGENT_INSTRUCTIONS.md`
   (section *Instructions*).
5. **Settings → Generative AI:** set orchestration to **Generative** (the agent
   chooses tools itself). Leave the model on the default.
6. Select **Create** / **Save**.

### 2.1 Add knowledge, so the agent can answer "why" questions

**Knowledge → + Add knowledge**:

1. **Files:** upload `docs/BREEZE_UP_RULES.md` (the plain-English rules,
   glossary and how to read the output).
2. **SharePoint:** add the `Sales` folder of the site, so it can find past
   programmes such as the 25RTR final schedule.
3. Turn **off** "Allow the AI to use its own general knowledge", so answers stay
   grounded in NZB material.

---

## Part 3: Create the agent flow "Build Breeze Up Schedule" (about 45 minutes)

1. In the agent, go to **Tools** → **+ Add a tool** → **New tool** → **Agent
   flow**. (Or: left menu **Flows** → **+ New flow** → **Agent flow**.) The
   designer opens with the **When an agent calls the flow** trigger and a
   **Respond to the agent** action already in place.
2. Rename the flow (top left) to **Build Breeze Up Schedule**.

### 3.1 Trigger inputs

Select the trigger and add these inputs:

| Input name | Type | Description (the agent reads this) |
|---|---|---|
| `SaleCode` | Text | Sale code, e.g. 26RTR or 27RTR |
| `PreferLanes` | Number | Preparers breezing at once. 0 = automatic |
| `Seed` | Number | 0 = normal. Any other number gives an alternative draft |
| `OnlyDay` | Text | Blank = all days, or a single day such as Mon |
| `RequesterEmail` | Text | Email of the person asking |

### 3.2 Reply to the agent straight away

Copilot Studio only waits **100 seconds** for a tool, and a big sale can take
longer than that to solve. So the flow answers first and keeps working.

1. Drag the existing **Respond to the agent** action up so it sits directly
   under the trigger.
2. Add an output: **Text** `Status` with the value
   `Started building the [SaleCode] breeze up schedule. I'll message you in Teams when it's ready (usually under 2 minutes).`
   Replace `[SaleCode]` by picking the **SaleCode** dynamic value from the
   trigger (the lightning-bolt icon).
3. In the action's **Settings**, make sure **Asynchronous response** is **Off**.

### 3.3 Find the workbook

Add **SharePoint → Get file metadata using path**:
- **Site Address:** your Sales site
- **File Path:** `/Shared Documents/Sales/@{SaleCode}/Breezeups/Heat Schedule/@{SaleCode}_Heat_Schedule.xlsx`
  (insert the `SaleCode` dynamic value in both places; adjust to your folder pattern)

### 3.4 Run the scheduler

Add **Excel Online (Business) → Run script from SharePoint library**:

| Field | Value |
|---|---|
| Workbook Location | the Sales site |
| Workbook Library | Documents |
| Workbook | **Id** from *Get file metadata using path* (dynamic) |
| Script Location | the Sales site |
| Script Library | Documents |
| Script | `Breeze Up Agent/Scripts/NZB Breeze Up Agent.osts` |
| preferLanes | `PreferLanes` (dynamic) |
| seed | `Seed` (dynamic) |
| onlyDay | `OnlyDay` (dynamic) |

Open the action's **Settings** and set **Retry policy** to *Fixed interval, 2
times, PT30S*. This covers the occasional "Conflict 409" when someone has the
file open.

### 3.5 Read the result

Add **Data Operation → Parse JSON**:
- **Content:** `result` from *Run script from SharePoint library*
- **Schema:** paste this

```json
{
  "type": "object",
  "properties": {
    "sale": { "type": "string" },
    "errors": { "type": "array", "items": { "type": "string" } },
    "warnings": { "type": "array", "items": { "type": "string" } },
    "days": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "day": { "type": "string" },
          "heats": { "type": "number" },
          "clashes": { "type": "number" },
          "clashList": { "type": "array", "items": { "type": "string" } },
          "preparersActiveAtOnce": { "type": "number" },
          "longestPreparerWait": { "type": "number" },
          "options": { "type": "array", "items": { "type": "string" } },
          "preparerOrder": { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

### 3.6 Tell the user

1. Add **Data Operation → Select**:
   - From: `days` (from Parse JSON)
   - Map (switch to text mode):
     `@{item()['day']}: @{item()['heats']} heats, @{item()['clashes']} jockey clashes, @{item()['preparersActiveAtOnce']} preparers breezing at once (options: @{join(item()['options'], '; ')})`
2. Add **Microsoft Teams → Post message in a chat or channel**:
   - Post as: **Flow bot**. Post in: **Chat with Flow bot**
   - Recipient: `RequesterEmail`
   - Message:

   ```
   🏇 NZB Breeze Up Agent: @{SaleCode} draft schedule is ready.

   @{join(body('Select'), '<br>')}

   Data errors: @{length(body('Parse_JSON')?['errors'])}. Warnings: @{length(body('Parse_JSON')?['warnings'])}.
   @{join(body('Parse_JSON')?['errors'], '<br>')}

   Open the workbook: @{outputs('Get_file_metadata_using_path')?['body/{Link}']}
   Check the "Validation" and "Clashes" sheets before publishing the programme.
   ```

3. **Error path.** Add a second **Post message** action. In its **…** menu,
   choose **Configure run after** and tick **has failed** and **has timed
   out** for *Run script*. Message: *"The breeze up schedule for @{SaleCode}
   failed: the workbook may be open in desktop Excel, or the sale is too large
   for one run. Try again with OnlyDay = Mon, then Tue."*
4. **Save**, then **Publish** the flow.

> **Large sales.** If a run ever times out (Power Automate allows a script 120
> seconds), lower `annealSteps` in **Agent Config** to 8000, or have the agent
> run each day separately (`OnlyDay`). Per-day runs write their own
> `26RTR Mon Summary` / `26RTR Tue Summary` sheets.

---

## Part 4: Connect the flow to the agent as a tool (about 10 minutes)

1. Back in the agent: **Tools** → **+ Add a tool** → **Flow** → choose **Build
   Breeze Up Schedule** → **Add and configure**.
2. **Name:** `Build breeze up schedule`
3. **Description:** *Builds or rebuilds the breeze-up heat schedule for a sale
   (e.g. 26RTR) in that sale's Heat Schedule workbook. Use when the user asks to
   create, redo, re-run or change the heat order, or asks for an alternative.
   Use PreferLanes when the user wants a specific number of preparers breezing
   at once, and Seed (any number from 1 to 999) when they want a different
   version.*
4. **Inputs:**
   - `SaleCode`: *Dynamically fill with AI* (the agent asks if the user didn't say)
   - `PreferLanes`: *Dynamically fill with AI*, default `0`
   - `Seed`: *Dynamically fill with AI*, default `0`
   - `OnlyDay`: *Dynamically fill with AI*, default blank
   - `RequesterEmail`: *Set as a value* → formula `System.User.Email`
     (this needs **Settings → Security → Authenticate with Microsoft**, which is
     the default for Teams agents)
5. **Completion:** *Send specific response* → `{Status}`. Or let the agent
   write the response.
6. **Save.**

---

## Part 5: Starter prompts and test (about 20 minutes)

**Overview → Suggested prompts** (add these):

| Title | Prompt |
|---|---|
| Build schedule | Build the 26RTR breeze up schedule |
| Tighter groups | Re-run 26RTR Tuesday with 7 preparers at once |
| Another version | Give me an alternative 26RTR schedule |
| New sale setup | What do I need to set up for a new sale? |
| Explain | Why can't Troy Harris ride in heats next to each other? |

**Test** (the *Test your agent* panel):

1. "Build the 26RTR breeze up schedule". The agent should call the tool, say
   it has started, and a Teams message should arrive within about 2 minutes.
2. Open the workbook. Check that the `26RTR Summary` sheet shows **Mon 109
   heats / 0 clashes** and **Tue 114 heats / 0 clashes** (the expected result
   for the 26RTR data).
3. "Redo Tuesday with 7 preparers breezing at once" should call the tool with
   `PreferLanes=7, OnlyDay=Tue`.
4. "What's BUO?" should answer from the knowledge file.
5. Use the **activity map** to confirm which tool and inputs were used.

---

## Part 6: Publish to Teams and Microsoft 365 Copilot (about 10 minutes)

1. Select **Publish** (top right) → **Publish**.
2. **Channels** → **Teams and Microsoft 365 Copilot** → keep **Make agent
   available in Microsoft 365 Copilot** ticked → **Add channel**.
3. **Edit details:** short description, NZB icon, accent colour.
4. **Availability options:** **Show to my teammates and shared users** → add
   the Sales team's security group. (Use **Show to everyone in my org** only if
   wanted; that needs admin approval.)
5. Staff open Teams → **Apps** → **Built for your org** / **Built with Power
   Platform** → **NZB Breeze Up Agent** → **Add**.

---

## Part 7: The Agent Config sheet (how staff change the rules)

Every rule that might change between sales lives in the workbook's **Agent
Config** sheet, not in code. The script creates the sheet the first time it
runs. Repeatable settings (`day`, `consecutive`, `preparerAlias`,
`jockeyAlias`) can have as many rows as needed.

| Setting | Example | Meaning |
|---|---|---|
| saleCode | 27RTR | Label on output sheets |
| day | `Mon \| Mon \| Mon Order` | Day name \| horses sheet \| preferred-order sheet. Add a row for a third day, e.g. `Wed \| Wed \| Wed Order` |
| minHeatsBetween | 4 | Heats between a jockey's rides |
| laneOptions | 5, 6, 7, 8 | Preparers breezing at once to try, tightest first |
| preferLanes | 0 | Force a width (0 = automatic) |
| maxBuoShift | 2 | How far a heat may move from the preparer's BUO order (0 = never) |
| orderFlex | 2 | How far a preparer may move from the preferred order |
| consecutive | `Prima Park \| Mon \| 2` | Preparer \| day (`*` = every day) \| heats back-to-back |
| preparerAlias | `Mark Brooks / Alex Olivera => Mark Brooks` | Merge name variants |
| jockeyAlias | `Ryan Elliott => Ryan Elliot` | Merge name variants |
| noJockeyTokens | No Jockey, TBC, TBA | Values meaning no rider booked |
| startTime / minutesPerHeat | 08:00 / 2 | Optional Time column |
| annealSteps | 20000 | Optimiser effort. Lower it if the script times out |
| seed | 26 | Change it for a different equally-good draft |

**Column headers are matched by name, not position.** For example `Jockey`,
`Jockey #1`, `Rider` and `Riders` are all accepted, so inserting or reordering
columns doesn't break anything. Accepted header names are listed in
`src/core.ts → defaultConfig().columns`.

---

## Part 8: Each new sale (about 10 minutes)

1. Create `Sales/<SALE>/Breezeups/Heat Schedule/<SALE>_Heat_Schedule.xlsx` with
   the usual sheets (`Mon`, `Tue`, `Mon Order`, `Tue Order`). Any number of
   preparers, horses and jockeys is fine.
2. Copy last sale's **Agent Config** sheet into it. Update `saleCode`, review
   the `consecutive` rules (is Prima Park still sending pairs? Is anyone else?)
   and clear old aliases.
3. In Teams: *"Build the <SALE> breeze up schedule"*.
4. Fix anything in the **Validation** sheet that is marked **ERROR** (duplicate
   lots, a lot on two days, missing BUO), then ask the agent to run it again.
5. Look at **Options** to choose between clash-free and tighter grouping, and
   ask for that width if needed.
6. Review `Mon Programme` / `Tue Programme`, make any manual tweaks, and
   publish.

---

## Part 9: Governance and support

- **Solution:** build the agent and flow inside a Power Platform **solution**
  (e.g. *NZB Breeze Up Agent*) so you can move dev → prod and keep versions.
- **Connections:** the flow runs Excel and SharePoint with the **maker's**
  connection by default. Use a shared service account for production, so the
  flow doesn't break when one person changes role.
- **Script updates:** when the code in this repository changes, run
  `npm run build:office`, open the `.osts` in Excel → Code Editor, paste the new
  `dist-office/NZB_Breeze_Up_Agent.ts`, and **Save**. The flow picks it up
  automatically.
- **Ownership:** a primary and a backup owner for the agent, the flow and the
  script folder.
- **Usage:** Copilot Studio **Analytics** shows runs and failures. Flow run
  history shows script errors.
