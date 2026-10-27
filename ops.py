"""All commands lock the same inode; backups capture all databases while quiescent."""
import os,sys,fcntl,subprocess,sqlite3,json,shutil,tempfile,pathlib,signal,stat
def main():
 os.umask(0o077)
 data=pathlib.Path('/app/data'); cmd=sys.argv[1]
 if cmd=='init-volumes':
  for p in ['/app/data','/run/gymbro','/run/gymbro-agent','/backups','/data','/config','/agent-data','/agent-config']:
   os.chown(p,1000,1000);os.chmod(p,0o700)
  for p in ['/data/caddy','/config/caddy','/agent-data/caddy','/agent-config/caddy']:
   os.makedirs(p,mode=0o700,exist_ok=True);os.chown(p,1000,1000);os.chmod(p,0o700)
  sys.exit()
 if data.is_symlink() or data.stat().st_uid!=os.getuid() or data.stat().st_mode&0o077:raise RuntimeError('Private owned data required')
 fd=os.open(data/'.owner-lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=os.getuid() or st.st_mode&0o077:raise RuntimeError('Private owned lock required')
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if cmd in ['serve','setup','renew','pair','recover-local']:
  child=subprocess.Popen(['node',{'serve':'server.cjs','setup':'setup.cjs','renew':'renew-claim.cjs','pair':'provision.cjs','recover-local':'recover-local.cjs'}[cmd]],stderr=subprocess.DEVNULL if cmd=='recover-local' else None)
  for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,lambda s,_:child.send_signal(s))
  status=child.wait()
  if cmd=='recover-local' and status:sys.stderr.write('Recovery failed\n')
  sys.exit(status)
 def check(p):
  c=sqlite3.connect(p);assert c.execute('pragma integrity_check').fetchall()==[('ok',)];assert not c.execute('pragma foreign_key_check').fetchall();c.close()
 if cmd=='backup':
  dest=pathlib.Path('/backups')/sys.argv[2]
  if dest.exists() or dest.name!=sys.argv[2]:raise RuntimeError('New simple backup name required')
  tmp=pathlib.Path(tempfile.mkdtemp(dir='/backups',prefix='.partial-'))
  try:
   for p in data.iterdir():
    if p.name=='.owner-lock':continue
    if p.is_symlink() or not p.is_file():raise RuntimeError('Unexpected entry')
    if p.suffix=='.sqlite':
     src=sqlite3.connect(f'file:{p}?mode=ro',uri=True);src.execute('pragma query_only=on');out=sqlite3.connect(tmp/p.name);src.backup(out);out.close();src.close();check(tmp/p.name)
    elif p.name=='agent-cli.json':continue
    elif p.name=='config.json':shutil.copyfile(p,tmp/p.name)
    elif p.name.endswith(('-journal','-wal','-shm')):continue
    else:raise RuntimeError('Unexpected data file')
   assert {'owner.sqlite','workout.sqlite','control.sqlite','config.json'}<=set(p.name for p in tmp.iterdir())
   for p in tmp.iterdir():
    os.chmod(p,0o600)
    with p.open('rb') as f:os.fsync(f.fileno())
   os.rename(tmp,dest)
   for p in [dest,pathlib.Path('/backups')]:
    f=os.open(p,os.O_RDONLY);os.fsync(f);os.close(f)
  finally:
   if tmp.exists():shutil.rmtree(tmp)
  print('Consistent quiescent SQLite online backup complete')
 elif cmd=='restore':
  src=pathlib.Path('/backups')/sys.argv[2]
  if src.name!=sys.argv[2] or src.is_symlink():raise RuntimeError('Simple backup name required')
  if any(p.name!='.owner-lock' for p in data.iterdir()):raise RuntimeError('Restore requires empty data volume')
  assert set(p.name for p in src.iterdir())=={'owner.sqlite','workout.sqlite','control.sqlite','config.json'}
  for p in src.iterdir():
   if p.is_symlink() or not p.is_file():raise RuntimeError('Regular backup files required')
   if p.suffix=='.sqlite':check(p)
  # Any failure leaves an incomplete volume for inspection; success requires durable files and directory.
  for p in src.iterdir():
   target=data/p.name
   with p.open('rb') as source, target.open('xb') as out:
    os.chmod(target,0o600);shutil.copyfileobj(source,out);out.flush();os.fsync(out.fileno())
  dfd=os.open(data,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(dfd)
  finally:os.close(dfd)
  print('Restore complete; retain original volume until verified')
 else:raise RuntimeError('Unknown operation')
try:
 main()
except Exception:
 if len(sys.argv)>1 and sys.argv[1]=='recover-local':
  sys.stderr.write('Recovery failed\n');sys.exit(1)
 raise
