"""Run one synthetic CI stage with private logs and bounded nonsecret failure metadata."""
from pathlib import Path
import os,sys,subprocess,hashlib,re,stat
if len(sys.argv)<4:raise SystemExit('usage: run-stage.py STAGE LOG COMMAND [ARG...]')
stage,log=sys.argv[1:3]
if not re.fullmatch('[a-z0-9-]{1,80}',stage):raise SystemExit('Invalid stage')
p=Path(log)
if p.name!=log or p.suffix!='.log':raise SystemExit('Simple log filename required')
if p.exists() or p.is_symlink():
 s=p.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid():raise SystemExit('Owned regular log required')
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600);os.fchmod(fd,0o600)
print('RUN '+stage,flush=True)
with os.fdopen(fd,'wb') as out:
 try:result=subprocess.run(sys.argv[3:],stdout=out,stderr=subprocess.STDOUT)
 except OSError:raise SystemExit('FAIL '+stage+': process-start-failure; raw output suppressed') from None
if result.returncode:
 data=p.read_bytes();text=data.decode(errors='replace')
 markers=['AssertionError','PermissionError','ModuleNotFoundError','SyntaxError','SQLITE_BUSY','SQLITE_CONSTRAINT','EINTEGRITY','EACCES','ENOTFOUND','ECONNREFUSED','ETIMEDOUT','EBADENGINE','permission denied','operation not permitted']
 kinds=[m for m in markers if m.lower() in text.lower()]
 sites=sorted(set(re.findall(r'(?:/app/|/tests/)[a-zA-Z0-9_./-]+\.(?:cjs|js|py):[0-9]+(?::[0-9]+)?',text)))[:5]
 print('FAIL '+stage+': exit='+str(result.returncode)+' categories='+','.join(kinds)+' sites='+','.join(sites)+' bytes='+str(len(data))+' sha256='+hashlib.sha256(data).hexdigest(),flush=True)
 raise SystemExit(result.returncode if result.returncode>0 else 1)
print('PASS '+stage,flush=True)
