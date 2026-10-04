# NZB Breeze Up Agent: step-by-step build in Copilot Studio

## How James will use it

1. James opens **NZB Breeze Up Agent** in Teams (or Microsoft 365 Copilot).
2. He attaches the sale's **Heat Schedule workbook** (sheets `Mon`, `Tue`,
   `Mon Order`, `Tue Order`) and types *"Build the breeze up schedule"*.
3. The agent replies *"Got it, working on it"*. Within about 2 minutes a Teams
   message arrives with the summary and a link to **his workbook with the draft
   schedule sheets added**.
4. He can follow up: *"Redo Tuesday with 7 preparers at once"*, *"Give me
   another version"*, *"What does the Validation sheet mean?"*. No re-upload is
   needed in the same chat.

**Only the Heat Schedule workbook needs uploading.** The jockey file isn't
needed, because the agent works out each jockey's rides from the Heat Schedule.
Last year's example programme is uploaded **once**, by the builder, as
knowledge (Part 2.1).

The sale rules (4-heat gap, *Prima Park sends 2 in a row on Monday*, name
aliases) live in one shared **Agent Config** file in SharePoint, so James doesn't
need to add anything to his workbook. Whoever looks after the agent updates that
file once per sale (Part 8).

```
 James in Teams: attaches 26RTR_Heat_Schedule.xlsx  "Build the breeze up schedule"
        ▼
 NZB Breeze Up Agent (Copilot Studio)
   topic "Build schedule from uploaded file"
        │  passes the file (name + content) to the flow
        ▼
 Agent flow "Build Breeze Up Schedule"
   1. Respond to agent: "working on it"              (Copilot waits ≤100 s)
   2. Save the upload to SharePoint › Breeze Up Agent › Runs
   3. Read sale rules from SharePoint › Breeze Up Agent › Agent Config.xlsx
   4. Run script "NZB Breeze Up Agent" on the saved copy  (≤120 s)
   5. Teams message to James: summary + link to the workbook with the new sheets
```

> **Why the agent doesn't plan the heats itself.** Ordering 100+ heats so that
> no jockey rides too soon is a puzzle with thousands of combinations, and an AI
> chat model can't check every gap reliably. Deterministic code (an Excel
> **Office Script**) does the solving and gives the same, checkable answer every
> time. The Copilot agent is the front door. See `SOLUTION_ARCHITECTURE.md`.

Time to build: about 2 to 3 hours the first time.

---

## Part 0: Prerequisites (once, with IT if needed)

| Need | Why |
|---|---|
| Copilot Studio access (licence or pay-as-you-go environment) | build the agent and flow |
| Microsoft 365 business licence with **Office Scripts** enabled (Excel shows an **Automate** tab) | runs the scheduler |
| A SharePoint / Teams site for Sales (e.g. *NZB Sales*) | stores the script, the shared config and each run's workbook |
| Power Platform policy allows **Excel Online (Business)**, **SharePoint** and **Microsoft Teams** connectors together | the flow uses all three |
| Teams admin allows Power Platform apps | so James can install the agent |

The uploaded workbook must be a normal `.xlsx` with **no password or
encrypting sensitivity label**, because Copilot can't pass protected files.

### 0.1 Create the agent's SharePoint folder

In the Sales site's **Documents** library, create:

```
Breeze Up Agent/
  Scripts/              ← the Office Script (.osts) lives here
  Runs/                 ← each upload is saved here with the draft sheets added
  Agent Config.xlsx     ← copy of templates/Agent_Config.xlsx from this repository
```

Give the Sales team **edit** access to `Runs`. Only the agent's owners need edit
access to `Scripts` and `Agent Config.xlsx`.

---

## Part 1: Install the scheduler script (about 15 minutes)

1. Open any copy of the 26RTR Heat Schedule workbook **in Excel for the web**.
2. Select **Automate** → **New Script** → **Create in Code Editor**.
3. Delete the sample code. Open
   `nzb-breeze-up-agent/dist-office/NZB_Breeze_Up_Agent.ts` from this repository,
   copy **all** of it, and paste it in.
4. Click the script name, rename it **NZB Breeze Up Agent**, and select **Save script**.
5. Click the name again → **Move** → choose `Breeze Up Agent/Scripts` on the Sales
   site. The script is now team-owned and keeps working if someone leaves.
6. **Test it straight away:** select **Run**. After 20–60 seconds you'll see an
   `Agent Config` sheet and new sheets such as `26RTR Summary`,
   `26RTR Mon Schedule`, `26RTR Mon Programme`, `26RTR Options` and
   `26RTR Validation`. (When run by hand like this, the script uses an
   `Agent Config` sheet inside the workbook. When run by the agent, it uses the
   shared file.)

### 1.1 Fill in the shared Agent Config

Open `Breeze Up Agent/Agent Config.xlsx`. It contains a table called
**ConfigTable** (Setting | Value | Notes). Check the yellow **Value** cells. The
26RTR rules are already filled in:

| Setting | Value |
|---|---|
| saleCode | 26RTR |
| day | Mon \| Mon \| Mon Order |
| day | Tue \| Tue \| Tue Order |
| minHeatsBetween | 4 |
| consecutive | Prima Park \| Mon \| 2 |
| preparerAlias | Mark Brooks / Alex Olivera => Mark Brooks |

Add rows **inside the table** for more days, rules or aliases (see Part 7).
Don't rename the table.

---

## Part 2: Create the agent (about 15 minutes)

1. Go to <https://copilotstudio.microsoft.com> and pick the right environment
   (top right).
2. **Agents** → **+ New agent** → **Skip to configure**.
3. **Name:** `NZB Breeze Up Agent`
   **Description:** *Builds and explains NZB breeze-up heat schedules. Attach the
   Heat Schedule workbook and ask it to build the schedule.*
4. **Instructions:** paste the text from `docs/AGENT_INSTRUCTIONS.md`.
5. **Create**.
6. **Settings → Generative AI:**
   - Orchestration: **Generative**.
   - **File processing capabilities → File uploads: On**. This is what lets
     James attach the workbook. (The agent doesn't need to read the spreadsheet
     itself; it passes the file on to the flow.)
   - **Save**.
7. **Settings → Security → Authentication:** keep **Authenticate with
   Microsoft** (the default for Teams). This gives the agent James's email
   address for the Teams message.

### 2.1 Knowledge (for "why" and "how" questions)

**Knowledge → + Add knowledge → Files:**
- `docs/BREEZE_UP_RULES.md` (rules, glossary, how to read every output sheet)
- `25RTR_Breeze_Up_Schedule_Example.xlsx`, or better, a PDF export of its final
  Monday programme, as an example of a finished programme

Turn **off** "Allow the AI to use its own general knowledge".

---

## Part 3: Create the agent flow "Build Breeze Up Schedule" (about 45 minutes)

1. Left menu **Flows** → **+ New flow** → **Agent flow**. The designer opens with
   **When an agent calls the flow** and **Respond to the agent**.
2. Rename it **Build Breeze Up Schedule** (top left).

### 3.1 Trigger inputs

Select the trigger → **+ Add an input**:

| Type | Name | Notes |
|---|---|---|
| **File** | `HeatScheduleFile` | the workbook James attached |
| Number | `PreferLanes` | preparers breezing at once, 0 = automatic |
| Number | `Seed` | 0 = normal. Another number gives an alternative version |
| Text | `OnlyDay` | blank = all days, or e.g. `Tue` |
| Text | `RequesterEmail` | who gets the Teams message |

### 3.2 Reply to the agent straight away

Copilot waits at most **100 seconds** for a flow, and the solver can take
longer. So the flow answers first and keeps working afterwards.

1. Drag **Respond to the agent** to sit directly under the trigger.
2. Add a Text output **Status**:
   `Thanks, I've got the workbook. I'm building the schedule now and will message you in Teams in about 2 minutes.`
3. In its **Settings**, check that **Asynchronous response** is **Off**.

### 3.3 Save the uploaded workbook to SharePoint

**SharePoint → Create file**:
- **Site Address:** the Sales site
- **Folder Path:** `/Shared Documents/Breeze Up Agent/Runs`
- **File Name** (expression):
  `concat(formatDateTime(convertFromUtc(utcNow(),'New Zealand Standard Time'),'yyyy-MM-dd HHmm'), ' ', triggerBody()?['file']?['name'])`
  (In the expression editor, pick the **HeatScheduleFile → name** dynamic value
  instead of typing the `triggerBody()` part.)
- **File Content:** the **HeatScheduleFile → contentBytes** dynamic value.
  If the saved file won't open, wrap it as
  `base64ToBinary(<contentBytes>)`.

Then **SharePoint → Get file properties**: Site = Sales site, Library =
Documents, Id = **ItemId** from *Create file*. This gives a link for the Teams
message.

### 3.4 Read the shared sale rules

1. **Excel Online (Business) → List rows present in a table**:
   Location = Sales site, Library = Documents,
   File = `/Breeze Up Agent/Agent Config.xlsx`, Table = `ConfigTable`.
2. **Data Operation → Select**: From = `value` (from *List rows*).
   Switch the map to **text mode** and enter
   `concat(item()?['Setting'], ': ', item()?['Value'])`
3. **Data Operation → Compose** (rename it **ConfigText**):
   `join(body('Select'), decodeUriComponent('%0A'))`

### 3.5 Run the scheduler

**Excel Online (Business) → Run script from SharePoint library**:

| Field | Value |
|---|---|
| Workbook Location / Library | Sales site / Documents |
| Workbook | **Id** from *Create file* |
| Script Location / Library | Sales site / Documents |
| Script | `Breeze Up Agent/Scripts/NZB Breeze Up Agent.osts` |
| preferLanes | `PreferLanes` |
| seed | `Seed` |
| onlyDay | `OnlyDay` |
| configText | **Outputs** of *ConfigText* |

In the action's **Settings**, set **Retry policy** to *Fixed interval, count 2,
interval PT20S*. This covers the brief lock right after the file is created.

### 3.6 Read the result and message James

1. **Data Operation → Parse JSON**. Content = `result` of *Run script*. Schema:

```json
{
  "type": "object",
  "properties": {
    "sale": { "type": "string" },
    "errors": { "type": "array", "items": { "type": "string" } },
    "warnings": { "type": "array", "items": { "type": "string" } },
    "days": { "type": "array", "items": { "type": "object", "properties": {
      "day": { "type": "string" },
      "heats": { "type": "number" },
      "clashes": { "type": "number" },
      "clashList": { "type": "array", "items": { "type": "string" } },
      "preparersActiveAtOnce": { "type": "number" },
      "longestPreparerWait": { "type": "number" },
      "options": { "type": "array", "items": { "type": "string" } },
      "preparerOrder": { "type": "array", "items": { "type": "string" } }
    } } }
  }
}
```

2. **Data Operation → Select** (rename **DayLines**): From = `days`. Map, in text mode:
   `concat(item()?['day'], ': ', item()?['heats'], ' heats, ', item()?['clashes'], ' jockey clashes, ', item()?['preparersActiveAtOnce'], ' preparers at once. Options: ', join(item()?['options'], '; '))`
3. **Microsoft Teams → Post message in a chat or channel**:
   Post as **Flow bot**, Post in **Chat with Flow bot**, Recipient = `RequesterEmail`, Message:

   ```
   🏇 NZB Breeze Up Agent: your draft schedule is ready.
   [join(body('DayLines'), '<br>')]
   Data errors to fix: [length(body('Parse_JSON')?['errors'])]
   [join(body('Parse_JSON')?['errors'], '<br>')]
   Open the workbook: [Link to item from Get file properties]
   Check the Validation and Clashes sheets before publishing the programme.
   ```

   (Each `[...]` is an expression or dynamic value inserted with the editor.)
4. **Failure message.** Add another *Post message* with **Configure run after →
   has failed / has timed out** on *Run script*:
   *"Sorry, the schedule run failed. Check that the workbook has Mon, Tue, Mon
   Order and Tue Order sheets and isn't password-protected, then try again, or
   ask me to run one day at a time."*
5. **Save** → **Publish**.

---

## Part 4: Topic that takes the uploaded file (about 20 minutes)

Uploaded files have to be passed to a flow from a **topic**. (The *Tools* page's
"fill with AI" option can't pass files.)

1. **Topics → + Add a topic → From blank**. Name it **Build schedule from uploaded file**.
2. **Trigger:** *The agent chooses*. Description: *The user wants to build,
   re-run or get an alternative breeze up heat schedule, usually attaching the
   Heat Schedule workbook.*
3. **Topic inputs** (**Details** → **Inputs** → *Create a new variable*. Each is
   filled by the agent from the conversation, not asked as a question):
   - `PreferLanes` (Number, default 0): *preparers breezing at once, only if
     the user asks for a number*
   - `Seed` (Number, default 0): *any new number from 1 to 999 when the user
     wants another or alternative version*
   - `OnlyDay` (String, default blank): *a single day such as Mon or Tue, only
     if the user asks*
4. **Node: Set variable value.** Variable `Global.HeatFile`. Formula:
   `If(IsEmpty(System.Activity.Attachments), Global.HeatFile, First(System.Activity.Attachments))`
   This uses the file attached to the current message, otherwise the one from
   earlier in the chat, so "another version please" works without re-uploading.
5. **Node: Condition.** `IsBlank(Global.HeatFile)` is true →
   **Question** node: *"Please attach the Heat Schedule workbook (with Mon, Tue,
   Mon Order and Tue Order sheets)."*. Identify: **File**. Under **…** →
   **Properties** → **Entity recognition**, tick **Include file metadata**.
   Save the response to `Global.HeatFile`.
6. **Node: Add a tool → Build Breeze Up Schedule** (the flow). Inputs (formula):
   - HeatScheduleFile: `{ contentBytes: Global.HeatFile.Content, name: Global.HeatFile.Name }`
   - PreferLanes: `Topic.PreferLanes`. Seed: `Topic.Seed`. OnlyDay: `Topic.OnlyDay`
   - RequesterEmail: `System.User.Email`
7. **Node: Send a message:** `{Topic.Status}` (the flow's Status output).
8. **Save**.

---

## Part 5: Test (about 20 minutes)

Test **in Teams early**, because that's where James will attach files.

1. In the **Test your agent** panel, click the paper clip, attach
   `26RTR_Heat_Schedule.xlsx` and type *"Build the breeze up schedule"*. Expect
   the "working on it" reply.
2. Within about 2 minutes: a Teams message from Flow bot, and a new file in
   `Breeze Up Agent/Runs`. Its `26RTR Summary` sheet should show **Mon 109 heats
   / 0 clashes** and **Tue 114 heats / 0 clashes**.
3. In the same chat: *"Redo Tuesday with 7 preparers at once"*. The flow should
   run with PreferLanes 7 and OnlyDay Tue, without asking for the file again.
4. *"Give me another version"* should use a new Seed.
5. *"What is BUO?"* should be answered from the knowledge file.
6. A message with no attachment, *"Build the schedule"*, should make the agent
   ask for the workbook.

---

## Part 6: Publish to Teams for James (about 10 minutes)

1. **Publish** (top right).
2. **Channels → Teams and Microsoft 365 Copilot → Add channel**. Keep *Make agent
   available in Microsoft 365 Copilot* ticked.
3. **Edit details:** NZB icon, short and long description.
4. **Availability options → Show to my teammates and shared users** → add James
   and the Sales team group.
5. James: Teams → **Apps** → **Built with Power Platform** / **Built for your
   org** → **NZB Breeze Up Agent** → **Add**. Pin it.

**Suggested prompts** (agent **Overview**): *Build the breeze up schedule* ·
*Redo Tuesday with 7 preparers at once* · *Give me another version* · *What
does the Validation sheet mean?* · *What do I need for a new sale?*

---

## Part 7: The Agent Config settings

| Setting | Example | Meaning |
|---|---|---|
| saleCode | 27RTR | Label on output sheets |
| day | `Mon \| Mon \| Mon Order` | Day name \| horses sheet \| preferred-order sheet. One row per day; add `Wed \| Wed \| Wed Order` for a third day |
| minHeatsBetween | 4 | Heats between a jockey's rides |
| laneOptions | 5, 6, 7, 8 | Preparers breezing at once to try, tightest first |
| preferLanes | 0 | Force a width (0 = automatic) |
| maxBuoShift | 2 | How far a heat may move from the preparer's BUO order |
| orderFlex | 2 | How far a preparer may move from the preferred order |
| consecutive | `Prima Park \| Mon \| 2` | Preparer \| day (`*` = all) \| heats back-to-back |
| preparerAlias | `Mark Brooks / Alex Olivera => Mark Brooks` | Merge name variants |
| jockeyAlias | `Ryan Elliott => Ryan Elliot` | Merge name variants |
| noJockeyTokens | No Jockey, TBC | Values meaning no rider booked |
| startTime / minutesPerHeat | 08:00 / 2 | Optional Time column |
| annealSteps | 20000 | Optimiser effort. Use 8000 if runs time out |
| seed | 26 | Default version number |

If an uploaded workbook contains its own `Agent Config` sheet, that sheet
**overrides** the shared file for that run. This is useful for a one-off test.

Columns in the uploaded workbook are found **by header name**, so column order
doesn't matter. `Jockey`, `Jockey #1`, `Rider` and `Riders` all work, and the
same goes for preparer, vendor, BUO, lot, breeding and colours.

---

## Part 8: Each new sale (about 5 minutes for the agent's owner)

1. Open `Breeze Up Agent/Agent Config.xlsx`:
   - update `saleCode` (e.g. 27RTR);
   - review the `consecutive` rows (is Prima Park still sending pairs, and on
     which day? Anyone else?);
   - delete last year's `preparerAlias` / `jockeyAlias` rows that no longer apply.
2. Tell James it's ready. He uploads the new Heat Schedule workbook. New
   preparers, vendors, jockeys and any number of lots need **no changes**.
3. James fixes anything marked **ERROR** in the Validation sheet (in his own
   file) and uploads again.

---

## Part 9: Governance and support

- Build the agent and flow inside a Power Platform **solution** (*NZB Breeze Up
  Agent*) so you can move dev → prod and keep versions.
- Use a shared service account for the flow's SharePoint, Excel and Teams
  connections, so it doesn't break when people change roles.
- Clean-up: optionally add a scheduled flow that deletes `Runs` files older than
  90 days.
- **Script updates:** after code changes here, run `npm run build:office`, open
  the `.osts` in Excel's Code Editor, paste the new
  `dist-office/NZB_Breeze_Up_Agent.ts`, and **Save**.
- **Troubleshooting:** look in Copilot Studio **Analytics** and the flow's
  **run history**. A failed *Run script* step shows the script's error message.

### Alternative: no upload, file stays in SharePoint

If attachments are blocked in your tenant, James can instead save the workbook
as `Sales/<SALE>/Breezeups/Heat Schedule/<SALE>_Heat_Schedule.xlsx` and say
*"Build the 27RTR schedule"*. In that case the flow takes a `SaleCode` text input
and uses **Get file metadata using path** in place of *Create file*. All other
steps stay the same.
