# Exact breeze-up scheduler (OR-Tools CP-SAT)

`solve_exact.py` builds a heat order that meets **all** hard rules at the same time,
or proves that no such order exists:

| Rule | Setting |
|---|---|
| A jockey has at least 4 heats between rides | `--gap 4` |
| Between two heats of the same preparer there are 4 to 8 other heats | `--vmin 4 --vmax 8` |
| A heat moves at most 2 places from the preparer's BUO order (Prima pairs move as a pair) | `--shift 2` |
| Prima Park sends 2 heats back-to-back on Monday | `--pairs "prima park:mon:2"` |
| Preparers start as close as possible to the Order sheets | objective (soft) |

Tested on 26RTR: Monday (109 heats) and Tuesday (114 heats) both have 0 jockey
clashes and every preparer gap is 4 to 8. On Monday a strict BUO order
(`--shift 0`) is impossible.

## Run it on a PC

```
pip install ortools openpyxl
python solve_exact.py 26RTR_Heat_Schedule.xlsx --time 300 --out 26RTR_Schedule.xlsx
```

Options:
- `--day Mon`: one day only (repeat for several days)
- `--time 300`: seconds per day. Longer runs give an order closer to the preferred order.
- `--alias "old name=new name"`: merge preparer name variants (lower case, comma-separated)
- `--pairs "preparer:day:2"`: preparers sending heats back-to-back (comma-separated)

The output workbook keeps the original sheets and adds `Mon/Tue Schedule`,
`Mon/Tue Preparers`, `Mon/Tue Jockeys` and `Validation`.

## In Copilot

`copilot/breeze_up_exact.py` is the same model in compact form (under the
8,000-character instruction limit). It's pasted from
`docs/AGENT_INSTRUCTIONS_EXACT.md`. It only works if the Copilot code interpreter
has the `ortools` package (see Step 5a in `docs/COPILOT_STUDIO_SETUP.md`).
