import pathlib,sqlite3,subprocess,sys,json,os
D=pathlib.Path('/app/data'); B=pathlib.Path('/backups/fixture');B.mkdir(parents=True)
for n in ['owner.sqlite','workout.sqlite','control.sqlite']:
 c=sqlite3.connect(B/n);c.execute('create table fixture(id integer)');c.commit();c.close()
(B/'config.json').write_text('{}')
wrapper="""import os,sys,runpy
real=os.fsync;count=0
fail=int(sys.argv[1]);sys.argv=['ops.py','restore','fixture']
def sync(fd):
 global count
 count+=1
 if count==fail:raise OSError('injected durability failure')
 real(fd)
os.fsync=sync
runpy.run_path('/app/ops.py',run_name='__main__')
assert count==5,count
"""
for fail in range(1,6):
 p=subprocess.run([sys.executable,'-c',wrapper,str(fail)],capture_output=True,text=True)
 assert p.returncode and 'Restore complete' not in p.stdout and 'injected durability failure' in p.stderr,(fail,p.stdout,p.stderr)
 # An interrupted volume refuses a subsequent restore until explicitly replaced/cleared.
 p=subprocess.run([sys.executable,'/app/ops.py','restore','fixture'],capture_output=True,text=True)
 assert p.returncode and 'Restore requires empty' in p.stderr
 for f in D.iterdir():
  if f.name!='.owner-lock':f.unlink()
p=subprocess.run([sys.executable,'-c',wrapper,'0'],capture_output=True,text=True);assert p.returncode==0,(p.stdout,p.stderr)
print('PASS restore fsync fault injection at all four files and destination directory; interrupted restore refuses retry; five successful fsync calls precede success')
