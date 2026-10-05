"""Exact feasibility check / optimiser for the NZB breeze-up heat order (OR-Tools CP-SAT).

Hard rules:
  * every heat gets exactly one slot 1..N (no empty slots)
  * a jockey never rides twice within GAP heats (at least GAP heats between rides)
  * between two consecutive heats (turns) of the same preparer: VMIN..VMAX other heats
  * PAIRS preparers send two heats back-to-back (one "turn")
  * within a preparer, a turn moves at most SHIFT places from its BUO order
Soft (objective): preparers start close to the preferred order.

usage: python3 solve_exact.py INPUT.xlsx [--shift 2] [--vmin 4] [--vmax 8] [--gap 4] [--time 120] [--day Mon] [--fixed-order] [--out file.xlsx]
"""
import re, sys, argparse, openpyxl
from ortools.sat.python import cp_model

ap = argparse.ArgumentParser()
ap.add_argument("input"); ap.add_argument("--shift", type=int, default=2)
ap.add_argument("--vmin", type=int, default=4); ap.add_argument("--vmax", type=int, default=8)
ap.add_argument("--gap", type=int, default=4); ap.add_argument("--time", type=float, default=120)
ap.add_argument("--day", action="append"); ap.add_argument("--out")
ap.add_argument("--fixed-order", action="store_true", help="preparers must start exactly in the Order-sheet order")
ap.add_argument("--pairs", default="prima park:mon:2"); ap.add_argument("--alias", default="mark brooks / alex olivera=mark brooks")
A = ap.parse_args()
k = lambda v: re.sub(r"\s+", " ", str(v or "")).strip().lower()
PAIRS = {(p, d): int(n) for p, d, n in (x.split(":") for x in A.pairs.split(",") if x)}
ALIAS = dict(x.split("=") for x in A.alias.split(",") if x)
NOJ = {"", "no jockey", "tbc", "tba", "n/a", "-", "none"}
wb = openpyxl.load_workbook(A.input)
def rows(n):
    ws = next((w for w in wb if k(w.title) == k(n)), None)
    return [list(r) for r in ws.iter_rows(values_only=True)] if ws else []
def col(h, *ns):
    for n in ns:
        for i, x in enumerate(h):
            if k(x) == k(n): return i
    return -1

def load(day):
    R = rows(day); h = R[0]
    P, B, L, J = col(h, "Preparer Name", "Preparer"), col(h, "BUO"), col(h, "Lot"), col(h, "Jockey", "Jockey #1", "Rider")
    V, G = col(h, "Vendor/Draft Name", "Vendor"), col(h, "Breeding")
    heats = {}
    for r in R[1:]:
        if not r[P]: continue
        p = ALIAS.get(k(r[P]), k(r[P]))
        heats.setdefault((p, float(r[B])), []).append(dict(prep=str(r[P]).strip(), vendor=r[V] if V >= 0 else "", buo=r[B], lot=r[L],
                                                        breeding=r[G] if G >= 0 else "", jockey=str(r[J] or "No Jockey").strip(), jk=k(r[J])))
    order = [ALIAS.get(k(r[0]), k(r[0])) for r in rows(day + " Order")[1:] if r and r[0]]
    preps = sorted({p for p, _ in heats}, key=lambda p: order.index(p) if p in order else 999)
    turns = {}   # preparer -> list of turns; a turn = list of heat keys sent back-to-back
    for p in preps:
        hk = sorted([x for x in heats if x[0] == p], key=lambda x: x[1]); n = PAIRS.get((p, k(day)), 1)
        turns[p] = [hk[i:i + n] for i in range(0, len(hk), n)]
    return heats, preps, turns, order

def solve(day):
    heats, preps, turns, order = load(day)
    N = len(heats); m = cp_model.CpModel()
    s = {h: m.NewIntVar(0, N - 1, f"s{h}") for h in heats}
    m.AddAllDifferent(list(s.values()))
    # turns: back-to-back inside a turn
    for p in preps:
        for t in turns[p]:
            for a, b in zip(t, t[1:]): m.Add(s[b] == s[a] + 1)
    # jockey: intervals of length GAP+1 must not overlap
    byj = {}
    for h, hs in heats.items():
        for x in hs:
            if x["jk"] not in NOJ: byj.setdefault(x["jk"], []).append(h)
    for j, hs in byj.items():
        m.AddNoOverlap([m.NewFixedSizeIntervalVar(s[h], A.gap + 1, f"j{j}{h}") for h in hs])
    # preparer: order turns (BUO order with at most SHIFT moves) and keep VMIN..VMAX heats between turns
    first = {}
    for p in preps:
        T = turns[p]; n = len(T); st = [s[t[0]] for t in T]; ln = [len(t) for t in T]
        if n == 1: first[p] = st[0]; continue
        L = ln[0]  # all turns of a preparer have the same length except maybe the last
        sh = A.shift // L   # shift is measured in heats
        pos = [m.NewIntVar(0, N - 1, f"pos{p}{r}") for r in range(n)]
        for r in range(n - 1):
            m.Add(pos[r + 1] - pos[r] >= L + A.vmin); m.Add(pos[r + 1] - pos[r] <= L + A.vmax)
        b = {}
        for u in range(n):
            for r in range(n):
                if abs(u - r) <= sh:
                    b[u, r] = m.NewBoolVar(""); m.Add(st[u] == pos[r]).OnlyEnforceIf(b[u, r])
                    if ln[u] != L and r != n - 1: m.Add(b[u, r] == 0)   # short last turn must be last
            m.AddExactlyOne(b[u, r] for r in range(n) if (u, r) in b)
        for r in range(n): m.AddExactlyOne(b[u, r] for u in range(n) if (u, r) in b)
        first[p] = pos[0]
    # soft: preparers start close to preferred order -> minimise sum |start(p_i) - start(p_{i+1})| inversions
    if A.fixed_order:
        for p, q in zip(preps, preps[1:]): m.Add(first[p] < first[q])
    inv = []
    for i, p in enumerate(preps):
        for q in preps[i + 1:]:
            v = m.NewBoolVar(""); m.Add(first[q] < first[p]).OnlyEnforceIf(v); m.Add(first[q] >= first[p]).OnlyEnforceIf(v.Not()); inv.append(v)
    late = []
    for i, p in enumerate(preps):
        l = m.NewIntVar(0, N, f'late{p}'); m.Add(l >= first[p] - i * N // max(1, len(preps))); late.append(l)
    m.Minimize(20 * sum(inv) + sum(late))
    sv = cp_model.CpSolver(); sv.parameters.max_time_in_seconds = A.time; sv.parameters.num_workers = 8
    st = sv.Solve(m)
    name = sv.StatusName(st)
    sol = None
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        sol = sorted(heats, key=lambda h: sv.Value(s[h]))
    return name, sol, heats, sum(sv.Value(v) for v in inv) if sol else None, sv.WallTime(), preps

out = openpyxl.load_workbook(A.input) if A.out else None
summ = []
for day in (A.day or ["Mon", "Tue"]):
    if not rows(day): continue
    name, sol, heats, obj, wt, preps = solve(day)
    print(f"{day}: {name} in {wt:.0f}s (gap {A.gap}, preparer {A.vmin}-{A.vmax}, BUO shift <= {A.shift})" + (f", order inversions {obj}" if sol else ""))
    if sol and out:
        ws = out.create_sheet(f"{day} Schedule")
        ws.append(["Heat", "Preparer", "Vendor", "BUO", "Lot", "Breeding", "Jockey", "Heats since last ride", "Preparer gap", "Check"])
        last, pe, jr, jn, ph = {}, {}, {}, {}, {}
        for i, h in enumerate(sol, 1):
            q = i - pe[h[0]] - 1 if h[0] in pe else ""; pe[h[0]] = i; ph.setdefault(h[0], []).append(i)
            for x in heats[h]:
                g = i - last[x["jk"]] - 1 if x["jk"] in last else ""
                bad = (g != "" and g < A.gap) or (q != "" and q > 0 and not A.vmin <= q <= A.vmax)
                ws.append([i, x["prep"], x["vendor"], x["buo"], x["lot"], x["breeding"], x["jockey"], g, q, "CHECK" if bad else "OK"])
                if x["jk"] not in NOJ: last[x["jk"]] = i; jr.setdefault(x["jk"], []).append(i); jn.setdefault(x["jk"], x["jockey"])
        pw = out.create_sheet(f"{day} Preparers")
        pw.append(["Preferred position", "Start position", "Preparer", "Heats", "First heat", "Last heat", "Largest gap between its heats"])
        starts = sorted(ph, key=lambda p: ph[p][0])
        for p in preps:
            hh = ph[p]; gaps = [b - a - 1 for a, b in zip(hh, hh[1:]) if b - a > 1]
            pw.append([preps.index(p) + 1, starts.index(p) + 1, heats[next(h for h in heats if h[0] == p)][0]["prep"], len(hh), hh[0], hh[-1], max(gaps, default="")])
        jw = out.create_sheet(f"{day} Jockeys")
        jw.append(["Jockey", "Rides", "First heat", "Last heat", "Smallest gap between rides", "Longest wait"])
        for j, hh in sorted(jr.items(), key=lambda z: z[1][0] - z[1][-1]):
            gp = [b - a - 1 for a, b in zip(hh, hh[1:])]
            jw.append([jn[j], len(hh), hh[0], hh[-1], min(gp, default=""), max(gp, default="")])
        summ.append(f"{day}: {len(sol)} heats, solver status {name}, 0 jockeys with fewer than {A.gap} heats between rides, all preparer gaps {A.vmin}-{A.vmax}, BUO moves <= {A.shift}, preferred-order swaps {obj}")
    elif out:
        summ.append(f"{day}: no schedule meeting all hard rules found ({name})")
if out:
    v = out.create_sheet("Validation"); [v.append([x]) for x in summ]
    out.save(A.out); print("wrote", A.out)
