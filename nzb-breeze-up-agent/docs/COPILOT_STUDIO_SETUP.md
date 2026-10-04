# NZB Breeze Up Agent: step-by-step build in Copilot Studio

## How James will use it (everything happens in the Copilot chat)

1. James opens **NZB Breeze Up Agent** in Teams or Microsoft 365 Copilot.
2. He attaches the sale's **Heat Schedule workbook** (sheets `Mon`, `Tue`,
   `Mon Order`, `Tue Order`) and types *"Build the breeze up schedule"*.
3. About a minute later, **in the same chat**, the agent replies with:
   - a summary (heats, jockey clashes and preparers at once for each day, plus
     any data errors to fix);
   - a **⬇ Download** link to the finished workbook, with all the original sheets
     plus the draft schedule sheets;
   - an **Open in Excel** link.
   The links are **temporary**: the file is deleted automatically after 7 days.
4. He can carry on in the same chat: *"Redo Tuesday with 7 preparers at once"*,
   *"Give me another version"*, *"What does the Validation sheet mean?"*. He
   doesn't need to upload again.

James never visits SharePoint or OneDrive. He only uploads **one file**: the jockey
file isn't needed, because the agent works out jockey rides from the Heat Schedule.

### What happens behind the chat

```
 James: 📎 26RTR_Heat_Schedule.xlsx  "Build the breeze up schedule"
        ▼
 NZB Breeze Up Agent ── topic "Build schedule from uploaded file"
        │ passes the file to the flow and waits (≤100 s)
        ▼
 Agent flow "Build Breeze Up Schedule"
   1. save the upload to a hidden work folder (OneDrive of a service account)
   2. read the sale rules from Agent Config.xlsx in the same folder
   3. run the Office Script "NZB Breeze Up Agent" (time budget 45 s)
   4. create an organisation-only link
   5. ⇦ Respond to the agent: summary + download link  → shown in the chat
   6. (after replying) wait 7 days, then delete the file, so the link expires
```

**Why a work folder is needed at all:** Excel Office Scripts can only run on a
workbook stored in OneDrive for Business or SharePoint, not on a file held in the
chat. The folder is just a temporary workspace. James never sees it, and every
file is deleted after 7 days.

**Why the agent doesn't plan the heats itself:** ordering 100+ heats so that no
jockey rides too soon is a puzzle with thousands of combinations, which an AI chat
model can't check reliably. Deterministic code (the Office Script) solves it and
gives the same, checkable answer every time. Copilot is the front door. See
`SOLUTION_ARCHITECTURE.md`.

Time to build: about 2 to 3 hours.

---

## Part 0: Prerequisites (once, with IT)

| Need | Why |
|---|---|
| Copilot Studio access (licence or pay-as-you-go environment) | build the agent and flow |
| Microsoft 365 business licence with **Office Scripts** enabled (Excel shows an **Automate** tab) | runs the scheduler |
| A **service account** with OneDrive, e.g. `breezeup.agent@nzb.co.nz` (a shared mailbox-style user licensed for M365) | owns the work folder and the flow connections, so nothing depends on one person |
| Power Platform policy allows **OneDrive for Business** and **Excel Online (Business)** connectors | the flow uses both |
| Teams admin allows Power Platform apps | so James can install the agent |

The uploaded workbook must be a normal `.xlsx` with **no password or
encrypting sensitivity label**, because Copilot can't pass protected files.

> If you'd rather not use a service account, a SharePoint document library works
> too. Use the SharePoint versions of the same actions (*Create file*, *Run script
> from SharePoint library*, *Create sharing link*, *Delete file*).

### 0.1 Create the work folder

Sign in to OneDrive **as the service account** and create:

```
Breeze Up Agent/
  Runs/                 ← uploads are saved here (deleted after 7 days)
  Agent Config.xlsx     ← copy of templates/Agent_Config.xlsx from this repository
```

---

## Part 1: Install the scheduler script (about 15 minutes, as the service account)

1. Upload any copy of the 26RTR Heat Schedule workbook to the service account's
   OneDrive and open it in **Excel for the web**.
2. Go to **Automate** → **New Script** → **Create in Code Editor**.
3. Delete the sample code. Paste in **all** of
   `nzb-breeze-up-agent/dist-office/NZB_Breeze_Up_Agent.ts`.
4. Rename the script **NZB Breeze Up Agent** and select **Save script**. It's
   saved in the service account's OneDrive (`Documents/Office Scripts`).
5. **Test:** select **Run**. After 20–60 seconds new sheets appear, such as
   `26RTR Summary` showing **Mon 109 heats / 0 clashes**. Delete this test copy
   afterwards.

### 1.1 Check the sale rules

Open `Breeze Up Agent/Agent Config.xlsx`. It has a table called **ConfigTable**
(Setting | Value | Notes). The 26RTR rules are already filled in: sale code,
Mon/Tue sheets, the 4-heat gap, `consecutive: Prima Park | Mon | 2`, and
`preparerAlias: Mark Brooks / Alex Olivera => Mark Brooks`. Edit only the yellow
Value cells, and add rows inside the table (see Part 7).

---

## Part 2: Create the agent (about 15 minutes)

1. Go to <https://copilotstudio.microsoft.com> and choose the environment (top right).
2. **Agents** → **+ New agent** → **Skip to configure**.
3. **Name:** `NZB Breeze Up Agent`
   **Description:** *Builds and explains NZB breeze-up heat schedules. Attach the
   Heat Schedule workbook and ask it to build the schedule.*
4. **Instructions:** paste the text block from `docs/AGENT_INSTRUCTIONS.md`.
5. Select **Create**.
6. **Settings → Generative AI**:
   - Orchestration: **Generative**.
   - **File uploads: On**. This lets James attach the workbook.
   - **Save**.
7. **Settings → Security → Authentication:** keep **Authenticate with Microsoft**.
8. **Knowledge → + Add knowledge → Files**: upload `docs/BREEZE_UP_RULES.md` and
   last year's example programme. Turn off "use general knowledge".

---

## Part 3: Create the agent flow "Build Breeze Up Schedule" (about 45 minutes)

Create the flow's connections **as the service account** (or change them to it
afterwards).

1. **Flows** → **+ New flow** → **Agent flow**. Rename it **Build Breeze Up Schedule**.
2. **Trigger "When an agent calls the flow" → + Add an input:**

   | Type | Name |
   |---|---|
   | **File** | `HeatScheduleFile` |
   | Number | `PreferLanes` |
   | Number | `Seed` |
   | Text | `OnlyDay` |

3. **Keep "Respond to the agent" at the bottom**, because this flow answers with
   the finished result. (Its outputs are set in step 9.)

4. **OneDrive for Business → Create file**
   - Folder Path: `/Breeze Up Agent/Runs`
   - File Name (expression):
     `concat(formatDateTime(convertFromUtc(utcNow(),'New Zealand Standard Time'),'yyyy-MM-dd HHmmss'), ' ', triggerBody()?['file']?['name'])`.
     Pick **HeatScheduleFile → name** from dynamic content for the last part.
   - File Content: **HeatScheduleFile → contentBytes**. If the saved file won't
     open, use `base64ToBinary(<contentBytes>)`.

5. **Excel Online (Business) → List rows present in a table**
   - Location: OneDrive for Business. File: `/Breeze Up Agent/Agent Config.xlsx`.
     Table: `ConfigTable`.
   - Then **Select**: From = `value`. Map (text mode) =
     `concat(item()?['Setting'], ': ', item()?['Value'])`
   - Then **Compose** (rename it **ConfigText**) =
     `join(body('Select'), decodeUriComponent('%0A'))`

6. **Excel Online (Business) → Run script**

   | Field | Value |
   |---|---|
   | Location / Document Library | OneDrive for Business / OneDrive |
   | File | **Id** from *Create file* |
   | Script | NZB Breeze Up Agent |
   | preferLanes | `PreferLanes` |
   | seed | `Seed` |
   | onlyDay | `OnlyDay` |
   | configText | Outputs of **ConfigText** |
   | timeBudgetSeconds | `45` |

   The 45-second budget makes the solver stop in time and return the best
   schedule found, so the whole flow answers within Copilot's 100-second limit.
   For the 26RTR data, 10 seconds was already enough for 0 clashes.

7. **Parse JSON**: Content = `result` of *Run script*. Schema:

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

8. **OneDrive for Business → Create share link**
   - File: **Id** from *Create file*. Link type: **View**. Link scope:
     **Organization** (only signed-in NZB staff can open it).
   - Then **Select** (rename it **DayLines**): From = `days`. Map (text mode):
     `concat('• ', item()?['day'], ': ', item()?['heats'], ' heats, ', item()?['clashes'], ' jockey clashes, ', item()?['preparersActiveAtOnce'], ' preparers breezing at once')`

9. **Respond to the agent**. Add these Text outputs:

   | Output | Value (expression) |
   |---|---|
   | `Summary` | `join(body('DayLines'), decodeUriComponent('%0A'))` |
   | `Errors` | `join(body('Parse_JSON')?['errors'], decodeUriComponent('%0A'))` |
   | `OpenLink` | **Web URL** from *Create share link* |
   | `DownloadLink` | `if(contains(outputs('Create_share_link')?['body/WebUrl'],'?'), concat(outputs('Create_share_link')?['body/WebUrl'],'&download=1'), concat(outputs('Create_share_link')?['body/WebUrl'],'?download=1'))` |

   In the action's **Settings**, make sure **Asynchronous response** is **Off**.

10. **After** *Respond to the agent* (these steps keep running in the background):
    - **Delay**: Count `7`, Unit `Day`
    - **OneDrive for Business → Delete file**: File = **Id** from *Create file*.
      Once the file is deleted, the link stops working.

11. **Error handling.** Add a second **Respond to the agent** in a parallel branch
    after *Run script*, with **Configure run after → has failed / has timed out**,
    and the same outputs: `Summary` = *"The schedule could not be built. Check the
    workbook has Mon, Tue, Mon Order and Tue Order sheets and isn't
    password-protected, then try again."* and the others blank.

12. **Save** → **Publish**.

---

## Part 4: Topic that takes the file and shows the result in chat (about 20 minutes)

Uploaded files have to be passed to a flow from a topic.

1. **Topics → + Add a topic → From blank**: **Build schedule from uploaded file**.
2. **Trigger:** *The agent chooses*. Description: *The user wants to build, re-run
   or get another version of the breeze up heat schedule, usually attaching the
   Heat Schedule workbook.*
3. **Topic inputs** (Details → Inputs; filled by the agent from the conversation):
   - `PreferLanes` (Number, default 0): *only if the user asks for a number of
     preparers at once*
   - `Seed` (Number, default 0): *a new number 1–999 when the user wants another
     version*
   - `OnlyDay` (String, default blank): *a single day such as Mon or Tue, only if
     asked*
4. **Set variable value:** `Global.HeatFile` =
   `If(IsEmpty(System.Activity.Attachments), Global.HeatFile, First(System.Activity.Attachments))`
   This uses the file on this message, otherwise the one from earlier in the chat.
5. **Condition:** if `IsBlank(Global.HeatFile)` → **Question** node: *"Please
   attach the Heat Schedule workbook (Mon, Tue, Mon Order, Tue Order sheets)."*
   Identify: **File**. Tick **Include file metadata** (… → Properties → Entity
   recognition). Save the answer to `Global.HeatFile`.
6. **Send a message:** *"Building the schedule now. This takes about a minute…"*
7. **Add a tool → Build Breeze Up Schedule**. Inputs (formulas):
   - HeatScheduleFile: `{ contentBytes: Global.HeatFile.Content, name: Global.HeatFile.Name }`
   - PreferLanes `Topic.PreferLanes` · Seed `Topic.Seed` · OnlyDay `Topic.OnlyDay`
8. **Send a message** with the result:

   ```
   ✅ Draft breeze up schedule ready

   {Topic.Summary}

   ⬇ [Download the workbook]({Topic.DownloadLink})   ·   [Open in Excel]({Topic.OpenLink})
   (links work for 7 days)

   {If(IsBlank(Topic.Errors), "No data errors.", "⚠ Fix these in your workbook and upload again:" & Char(10) & Topic.Errors)}
   ```

   (Insert the variables with **{x}**. The last line is a Power Fx formula.)
   Optionally use an **Adaptive Card** with an *Action.OpenUrl* "Download" button
   in place of a plain message.
9. **Save**.

---

## Part 5: Test (about 20 minutes)

Test **in Teams** as well as in the test panel, because that's where James
attaches files.

1. Attach `26RTR_Heat_Schedule.xlsx` with 📎 and type *"Build the breeze up
   schedule"*. Within about a minute the chat shows **Mon: 109 heats, 0 jockey
   clashes** and **Tue: 114 heats, 0 jockey clashes**, plus the two links.
2. Click **Download**. The workbook downloads with the `26RTR Summary`,
   `Mon/Tue Schedule`, `Programme`, `Options`, `Clashes` and `Validation` sheets.
3. *"Redo Tuesday with 7 preparers at once"* runs again without a new upload.
4. *"Give me another version"* uses a new seed.
5. *"What is BUO?"* is answered from the knowledge file.
6. *"Build the schedule"* with no file attached makes the agent ask for the workbook.
7. Check the run time in the flow's **run history**. If it's above about 80
   seconds, lower `timeBudgetSeconds` to 30.

---

## Part 6: Publish to Teams for James (about 10 minutes)

1. **Publish** (top right).
2. **Channels → Teams and Microsoft 365 Copilot → Add channel**. Keep *Make agent
   available in Microsoft 365 Copilot* ticked.
3. **Edit details:** NZB icon and descriptions.
4. **Availability options → Show to my teammates and shared users** → add James
   and the Sales team group.
5. James: Teams → **Apps** → **Built with Power Platform** → **NZB Breeze Up
   Agent** → **Add**, then pin it.

**Suggested prompts** (agent Overview): *Build the breeze up schedule* · *Redo
Tuesday with 7 preparers at once* · *Give me another version* · *What does the
Validation sheet mean?*

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
| timeBudgetSeconds | 45 | Normally set by the flow. Stops and returns the best schedule found |

An `Agent Config` sheet inside an uploaded workbook overrides the shared file for
that run. Columns in the uploaded workbook are found **by header name**, so
`Jockey`, `Jockey #1`, `Rider` and so on all work, and column order doesn't matter.

---

## Part 8: Each new sale (about 5 minutes for the agent's owner)

1. Open `Breeze Up Agent/Agent Config.xlsx` (the service account's OneDrive):
   - update `saleCode`;
   - review the `consecutive` rows (Prima Park this year? Anyone else?);
   - remove old aliases.
2. James uploads the new workbook in the chat. New preparers, vendors, jockeys
   and any number of lots need no changes.

---

## Part 9: Governance and support

- Build the agent and flow inside a Power Platform **solution** (*NZB Breeze Up
  Agent*).
- The service account owns the work folder, the script and the flow connections.
  Give the password and MFA to IT, and add a backup flow owner.
- **Data:** uploads exist only in the work folder and are deleted after 7 days.
  Links are organisation-only.
- **Script updates:** after code changes here, run `npm run build:office`, sign in
  as the service account, and paste the new `dist-office/NZB_Breeze_Up_Agent.ts`
  into the script in Excel's Code Editor.
- **Troubleshooting:** Copilot Studio **Analytics** and the flow **run history**.
  If James gets "something unexpected happened", the flow probably took more than
  100 seconds. Lower `timeBudgetSeconds`.
