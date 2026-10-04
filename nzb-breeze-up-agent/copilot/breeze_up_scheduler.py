import openpyxl,random,re,time
F='INPUT.xlsx'
GAP=4;LANES=[5,6,7,8];SHIFT=2;RUNS=150;TRIES=3;SEED=26;BUDGET=60;DAYS=['Mon','Tue']
PAIRS={('prima park','mon'):2}
ALIAS={'mark brooks / alex olivera':'mark brooks'}
NOJ={'','no jockey','tbc','tba','n/a','-','none'}
def k(v):return re.sub(r'\s+',' ',str(v or '')).strip().lower()
wb=openpyxl.load_workbook(F);T0=time.time()
def rows(n):
 ws=next((w for w in wb if k(w.title)==k(n)),None)
 return [list(r) for r in ws.iter_rows(values_only=True)] if ws else []
def col(h,*ns):
 for n in ns:
  for i,x in enumerate(h):
   if k(x)==k(n):return i
 return -1
issues=[];seen={};JID={}
def day(d):
 R=rows(d);h=R[0];P=col(h,'Preparer Name','Preparer');B=col(h,'BUO');L=col(h,'Lot');J=col(h,'Jockey','Jockey #1','Rider');V=col(h,'Vendor/Draft Name','Vendor');G=col(h,'Breeding');D=col(h,'Day')
 H={};nm={}
 for r in R[1:]:
  if not r[P]:continue
  p=ALIAS.get(k(r[P]),k(r[P]));nm.setdefault(p,str(r[P]).strip());j=k(r[J]);lot=r[L]
  if lot in seen:issues.append(f'ERROR lot {lot} listed twice ({seen[lot]} and {d})')
  seen[lot]=d
  if j in NOJ:issues.append(f'INFO {d} lot {lot} has no jockey')
  if D>=0 and r[D] and k(r[D])!=k(d):issues.append(f'WARNING lot {lot} is on the {d} sheet but Day says {r[D]}')
  H.setdefault((p,r[B]),[]).append((r[P],r[V] if V>=0 else '',r[B],lot,r[G] if G>=0 else '',str(r[J] or 'No Jockey').strip(),'' if j in NOJ else JID.setdefault(j,len(JID))))
 by={}
 for (p,b),hs in sorted(H.items(),key=lambda x:(x[0][0],float(x[0][1]))):by.setdefault(p,[]).append(hs)
 O0=[ALIAS.get(k(r[0]),k(r[0])) for r in rows(d+' Order')[1:] if r and r[0]];O=[p for p in O0 if p in by]+[p for p in by if p not in O0];U={}
 for pi,p in enumerate(O):
  if p not in O0:issues.append(f'WARNING {d}: {nm[p]} not on {d} Order - scheduled last')
  n=PAIRS.get((p,k(d)),1);hs=by[p]
  for x in hs:
   js=[y[6] for y in x if y[6]!='']
   if len(js)>len(set(js)):issues.append(f'ERROR {d}: {nm[p]} BUO {x[0][2]} has the same jockey on both horses')
  U[p]=[(pi,r,hs[i:i+n],[(o,y[6]) for o,x in enumerate(hs[i:i+n]) for y in x if y[6]!=''],len(hs[i:i+n]),SHIFT//n) for r,i in enumerate(range(0,len(hs),n))]
 return [U[p] for p in O]
def score(seq,NP,lanes):
 last=[-99]*len(JID);v=0;first=[-1]*NP;lp=[0]*NP;cnt=[0]*NP;idle=mv=i=0;L=2*lanes
 for pi,r,u,J,n,S in seq:
  if first[pi]<0:first[pi]=i
  elif i-lp[pi]>L:idle+=i-lp[pi]-L
  d=abs(r-cnt[pi]);mv+=d+(1e5 if d>S else 0);cnt[pi]+=1
  for o,j in J:
   e=i+o-last[j]
   if e<=GAP:v+=1e6+(GAP+1-e)*1e4
   last[j]=i+o
  i+=n;lp[pi]=i-1
 return v+idle*1000+mv*20+100*sum(abs(a-b) for a,b in enumerate(sorted(range(NP),key=first.__getitem__)))
def greedy(U,lanes,rnd):
 NP=len(U);q=sorted(range(NP),key=lambda p:p+rnd.random()*2.9) if rnd else list(range(NP))
 act=[];last=[-99]*len(JID);seq=[];t=0;sv={}
 def ok(J):return all(t+o-last[j]>GAP for o,j in J) and len({j for o,j in J})==len(J)
 def add(p):act.append([p,list(U[p]),0]);sv[p]=t-1e9*(not seq)
 while act or q:
  while len(act)<lanes and q:add(q.pop(0))
  act.sort(key=lambda a:sv[a[0]]+(rnd.random()*2 if rnd else 0));pick=None
  for a in act:
   S=a[1][0][5];lim=0 if a[2]-a[1][0][1]>=S else min(S,len(a[1])-1)
   c=[i for i in range(lim+1) if ok(a[1][i][3])]
   if c:pick=(a,c[0]);break
  if not pick and q and ok(U[q[0]][0][3]):add(q.pop(0));pick=(act[-1],0)
  if not pick:pick=min(((a,i) for a in act for i in range(min(a[1][0][5],len(a[1])-1)+1)),key=lambda x:sum(max(0,GAP+1-t-o+last[j]) for o,j in x[0][1][x[1]][3]))
  a,i=pick;x=a[1].pop(i);seq.append(x)
  for o,j in x[3]:last[j]=t+o
  t+=x[4];sv[a[0]]=t;a[2]+=1
  if not a[1]:act.remove(a)
 return seq
def polish(s,NP,lanes,rnd,end):
 c=b=score(s,NP,lanes);bs=s[:];N=max(12000,120*len(s));n=0
 while n<N and (n%200 or time.time()<end):
  T=3000*(1/1500)**(n/N);i=rnd.randrange(len(s));j=min(len(s)-1,max(0,i+rnd.randint(-2*lanes,2*lanes)));t=s[:];n+=1
  if rnd.random()<.5:t[i],t[j]=t[j],t[i]
  else:t.insert(j,t.pop(i))
  x=score(t,NP,lanes)
  if x<=c or rnd.random()<2.718**((c-x)/T):
   s,c=t,x
   if x<b:b,bs=x,t[:]
 return bs,b
out=openpyxl.load_workbook(F);summ=[];DD=[d for d in DAYS if rows(d)]
for di,dn in enumerate(DD):
 U=day(dn);NP=len(U);rnd=random.Random(SEED);best=None;dl=time.time()+(T0+BUDGET-time.time())/(len(DD)-di)
 for li,lanes in enumerate(LANES):
  le=dl if li==len(LANES)-1 else time.time()+(dl-time.time())/2
  for c in sorted((greedy(U,lanes,rnd if x else None) for x in range(RUNS)),key=lambda s:score(s,NP,lanes))[:TRIES]:
   s,b=polish(c,NP,lanes,rnd,time.time()+(le-time.time())/TRIES)
   if not best or b<best[1]:best=(s,b,lanes)
  if best[1]<1e6:break
 seq,b,lanes=best;ws=out.create_sheet(f'{dn} Schedule')
 ws.append(['Heat','Preparer','Vendor','BUO','Lot','Breeding','Jockey','Heats since last ride','Check']);last={};cl=0;i=0;fh={}
 for pi,r,u,J,n,S in seq:
  for h in u:
   i+=1
   for x in h:
    g=i-last[x[6]]-1 if x[6] in last else '';bad=g!=''and g<GAP;cl+=bad;fh.setdefault(x[0],[]).append(i)
    ws.append([i,x[0],x[1],x[2],x[3],x[4],x[5],g,'CLASH' if bad else 'OK'])
    if x[6]!='':last[x[6]]=i
 summ+=[f'{dn}: {i} heats, {cl} jockey clashes, {lanes} preparers breezing at once']+[f'  {dn} #{n+1} {q}: heats {min(v)}-{max(v)}' for n,(q,v) in enumerate(fh.items())]
v=out.create_sheet('Validation');[v.append([m]) for m in (summ+issues or ['No issues'])]
out.save('NZB_Breeze_Up_Schedule.xlsx');print('\n'.join([x for x in summ if x[0]!=' ']+[x for x in issues if not x.startswith('INFO')]))
