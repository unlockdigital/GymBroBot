from pathlib import Path
import subprocess,tempfile,sys,stat
script=Path(__file__).resolve().parent/'scripts/run-stage.py'
with tempfile.TemporaryDirectory(prefix='gymbro-stage-test-') as temp:
 marker='SYNTHETIC_PRIVATE_OUTPUT'
 p=subprocess.run([sys.executable,str(script),'synthetic-failure','test.log',sys.executable,'-c',"import sys; print('AssertionError '+sys.argv[1]+' at /app/example.cjs:12:3; Synthetic integration assertion failed phase=competing-empty-date-drafts; Agent request rejected (HTTP 409); at /test.cjs:49:2');sys.exit(7)",marker],cwd=temp,capture_output=True,text=True)
 assert p.returncode==7 and marker not in p.stdout+p.stderr and 'AssertionError' in p.stdout and '/app/example.cjs:12:3' in p.stdout and 'synthetic-failure' in p.stdout and 'phase=competing-empty-date-drafts' in p.stdout and 'http=409' in p.stdout and '/test.cjs:49:2' in p.stdout
 log=Path(temp)/'test.log';assert marker in log.read_text() and stat.S_IMODE(log.stat().st_mode)==0o600
 p=subprocess.run([sys.executable,str(script),'synthetic-pass','test.log',sys.executable,'-c','print("synthetic ok")'],cwd=temp,capture_output=True,text=True);assert p.returncode==0 and 'PASS synthetic-pass' in p.stdout
 log.unlink();log.symlink_to(Path(temp)/'outside');p=subprocess.run([sys.executable,str(script),'synthetic-deny','test.log',sys.executable,'-c','print("no")'],cwd=temp,capture_output=True,text=True);assert p.returncode!=0 and not (Path(temp)/'outside').exists()
print('PASS: CI stage labels, failure categories/site, private raw log, clean success and symlink rejection')
