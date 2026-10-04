import openpyxl,random,re
F='INPUT.xlsx'
GAP=4;LANES=[5,6,7,8];SHIFT=2;RUNS=150;STEPS=12000;TRIES=3;SEED=26;DAYS=['Mon','Tue']
PAIRS={('prima park','mon'):2}
ALIAS={'mark brooks / alex olivera':'mark brooks'}
NOJ={'','no jockey','tbc','tba','n/a','-','none'}
def k(v):return re.sub(r'\s+',' ',str(v or '')).strip().lower()
wb=openpyxl.load_workbook(F)
def rows(n):
 ws=next((w for w in wb if k(w.title)==k(n)),None)
 return [list(r) for r in ws.iter_rows(values_only=True)] if ws else []
def col(h,*ns):
 for n in ns:
  for i,x in enumerate(h):
   if k(x)==k(n):return i
 return -1
issues=[];seen={}
def day(d):
 R=rows(d);h=R[0];P=col(h,'Preparer Name','Preparer');B=col(h,'BUO');L=col(h,'Lot');J=col(h,'Jockey','Jockey #1','Rider');V=col(h,'Vendor/Draft Name','Vendor');G=col(h,'Breeding')
 H={};nm={}
 for r in R[1:]:
  if not r[P]:continue
  p=ALIAS.get(k(r[P]),k(r[P]));nm.setdefault(p,str(r[P]).strip());j=k(r[J]);lot=r[L]
  if lot in seen:issues.append(f'ERROR lot {lot} listed twice ({seen[lot]} and {d})')
  seen[lot]=d
  if j in NOJ:issues.append(f'INFO {d} lot {lot} has no jockey')
  H.setdefault((p,r[B]),[]).append((r[P],r[V] if V>=0 else '',r[B],lot,r[G] if G>=0 else '',str(r[J] or 'No Jockey').strip(),'' if j in NOJ else j))
 O=[ALIAS.get(k(r[0]),k(r[0])) for r in rows(d+' Order')[1:] if r and r[0]]
 by={}
 for (p,b),hs in sorted(H.items(),key=lambda x:(x[0][0],float(x[0][1]))):by.setdefault(p,[]).append((hs,[x[6] for x in hs if x[6]]))
 for p in by:
  if p not in O:issues.append(f'WARNING {d}: {nm[p]} not on {d} Order - scheduled last');O.append(p)
  n=PAIRS.get((p,k(d)),1);hs=by[p];by[p]=[hs[i:i+n] for i in range(0,len(hs),n)]
 return [p for p in O if p in by],by
def score(seq,pref,lanes):
 last={};v=0;first={};lp={};idle=0;mv=0;cnt={};L=2*lanes;i=0
 for p,r,u in seq:
  q=lp.get(p)
  if q is None:first[p]=i
  elif i-q>L:idle+=i-q-L
  c=cnt.get(p,0);d=abs(r-c);mv+=d+(1e5 if d>SHIFT else 0);cnt[p]=c+1
  for h,js in u:
   for j in js:
    d=i-last.get(j,-99)
    if d<=GAP:v+=1e6+(GAP+1-d)*1e4
    last[j]=i
   i+=1
  lp[p]=i-1
 ent=sorted(first,key=first.get)
 return v+idle*1000+mv*20+100*sum(abs(i-pref.index(p)) for i,p in enumerate(ent))
def greedy(pref,by,lanes,rnd):
 q=sorted(pref,key=lambda p:pref.index(p)+rnd.random()*2.9) if rnd else pref[:]
 act=[];last={};seq=[];t=0;sv={}
 def ok(u):return all(t+o-last.get(j,-99)>GAP for o,(h,js) in enumerate(u) for j in js) and len({j for h,js in u for j in js})==sum(len(js) for h,js in u)
 def add(p):act.append([p,list(enumerate(by[p])),0]);sv[p]=t-1e9*(not seq)
 while act or q:
  while len(act)<lanes and q:add(q.pop(0))
  act.sort(key=lambda a:sv[a[0]]+(rnd.random()*2 if rnd else 0));pick=None
  for a in act:
   lim=0 if a[2]-a[1][0][0]>=SHIFT else min(SHIFT,len(a[1])-1)
   c=[i for i in range(lim+1) if ok(a[1][i][1])]
   if c:pick=(a,c[0]);break
  if not pick and q and ok(by[q[0]][0]):add(q.pop(0));pick=(act[-1],0)
  if not pick:pick=(act[0],0)
  a,i=pick;r,u=a[1].pop(i);seq.append((a[0],r,u))
  for h,js in u:
   for j in js:last[j]=t
   t+=1
  sv[a[0]]=t;a[2]+=1
  if not a[1]:act.remove(a)
 return seq
def polish(s,pref,lanes,rnd):
 c=b=score(s,pref,lanes);bs=s[:]
 for n in range(STEPS):
  T=3000*(1/1500)**(n/STEPS);i=rnd.randrange(len(s));j=min(len(s)-1,max(0,i+rnd.randint(-2*lanes,2*lanes)));t=s[:]
  if rnd.random()<.5:t[i],t[j]=t[j],t[i]
  else:t.insert(j,t.pop(i))
  x=score(t,pref,lanes)
  if x<=c or rnd.random()<2.718**((c-x)/T):
   s,c=t,x
   if x<b:b,bs=x,t[:]
 return bs,b
out=openpyxl.load_workbook(F);summ=[]
for dn in DAYS:
 if not rows(dn):continue
 pref,by=day(dn);rnd=random.Random(SEED);best=None
 for lanes in LANES:
  for c in sorted((greedy(pref,by,lanes,rnd if x else None) for x in range(RUNS)),key=lambda s:score(s,pref,lanes))[:TRIES]:
   s,b=polish(c,pref,lanes,rnd)
   if not best or b<best[1]:best=(s,b,lanes)
  if best[1]<1e5:break
 seq,b,lanes=best;ws=out.create_sheet(f'{dn} Schedule')
 ws.append(['Heat','Preparer','Vendor','BUO','Lot','Breeding','Jockey','Heats since last ride','Check']);last={};cl=0;i=0
 for p,r,u in seq:
  for h,js in u:
   i+=1
   for x in h:
    g=i-last[x[6]]-1 if x[6] in last else '';bad=g!=''and g<GAP;cl+=bad
    ws.append([i,x[0],x[1],x[2],x[3],x[4],x[5],g,'CLASH' if bad else 'OK'])
    if x[6]:last[x[6]]=i
 summ.append(f'{dn}: {i} heats, {cl} jockey clashes, {lanes} preparers breezing at once')
v=out.create_sheet('Validation');[v.append([m]) for m in (summ+issues or ['No issues'])]
out.save('NZB_Breeze_Up_Schedule.xlsx');print('\n'.join(summ+[x for x in issues if not x.startswith('INFO')]))
