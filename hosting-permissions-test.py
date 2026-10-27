from pathlib import Path
import tempfile,shutil,subprocess,stat,hashlib
root=Path(__file__).resolve().parent
checks=0
with tempfile.TemporaryDirectory(prefix='gymbro-public-modes-') as temp:
 fixture=Path(temp);(fixture/'scripts').mkdir()
 for name in ['Caddyfile','Caddyfile.agent','SOURCE-MANIFEST.json','scripts/prepare-hosting.py']:
  shutil.copyfile(root/name,fixture/name)
 for name in ['Caddyfile','Caddyfile.agent']: (fixture/name).chmod(0o600)
 for name in ['.env','agent-cli.json']:
  p=fixture/name;p.write_text('synthetic-private-placeholder');p.chmod(0o600)
 def run():return subprocess.run(['python3',str(fixture/'scripts/prepare-hosting.py')],capture_output=True)
 assert run().returncode==0;checks+=1
 for name in ['Caddyfile','Caddyfile.agent']:
  assert stat.S_IMODE((fixture/name).stat().st_mode)==0o644;assert (fixture/name).read_bytes()==(root/name).read_bytes();checks+=1
 for name in ['.env','agent-cli.json']:
  assert stat.S_IMODE((fixture/name).stat().st_mode)==0o600;assert (fixture/name).read_text()=='synthetic-private-placeholder';checks+=1
 (fixture/'.env').chmod(0o644);(fixture/'Caddyfile').chmod(0o600);assert run().returncode!=0;assert stat.S_IMODE((fixture/'Caddyfile').stat().st_mode)==0o600;checks+=1;(fixture/'.env').chmod(0o600)
 (fixture/'Caddyfile').write_text('unreviewed-template');assert run().returncode!=0;checks+=1
 (fixture/'Caddyfile').unlink();(fixture/'Caddyfile').symlink_to(fixture/'Caddyfile.agent');assert run().returncode!=0;checks+=1
print('PASS '+str(checks)+' hosting permission checks')
