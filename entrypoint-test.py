"""Synthetic actual-image nonroot entrypoint and public proxy bind-mount checks."""
from pathlib import Path
import subprocess,sys,re,hashlib,uuid,os
root=Path(__file__).resolve().parent
image=sys.argv[1] if len(sys.argv)>1 else 'gymbro-vps-agent:security-20261027'
caddy=os.environ.get('GYMBRO_CADDY_IMAGE','gymbro-caddy:security-20261027')
def run(stage,args):
 print('RUN '+stage,flush=True)
 name='gymbro-entrypoint-'+uuid.uuid4().hex[:12]
 command=['docker',args[0],'--name',name,*args[1:]]
 try:
  p=subprocess.run(command,capture_output=True,text=True,timeout=120)
 except subprocess.SubprocessError:
  raise SystemExit('FAIL '+stage+': process timeout/start failure; output suppressed') from None
 finally:
  try:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)
  except subprocess.SubprocessError:pass
 if p.returncode:
  categories=[label for term,label in [('permission denied','file-permission'),('operation not permitted','capability-or-execution-policy'),('Cannot find module','missing-dependency'),('SQLITE_','sqlite'),('Error during parsing','proxy-config-parse')] if term.lower() in p.stderr.lower()]
  print('FAIL '+stage+': exit='+str(p.returncode)+' categories='+','.join(categories)+' stderr_sha256='+hashlib.sha256(p.stderr.encode()).hexdigest(),flush=True)
  raise SystemExit('Synthetic check failed; raw output remains suppressed')
 print('PASS '+stage,flush=True)
 return p.stdout
# setup runs the actual configured Python entrypoint as the image's nonroot user.
out=run('default-nonroot-setup',['run','--rm','--network','none','--log-driver','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/app/data:uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:mode=1777','-e','PUBLIC_ORIGIN=https://entrypoint.example',image,'setup'])
if not re.fullmatch(r'Private ten-minute enrollment capability: [A-Za-z0-9_-]{43}\n',out):raise SystemExit('FAIL setup-response-shape: bytes='+str(len(out))+'; credential output suppressed')
out=None
for name in ['Caddyfile','Caddyfile.agent']:
 run('proxy-config-'+name,['run','--rm','--network','none','--log-driver','none','--user','1000:1000','--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges','--tmpfs','/tmp:mode=1777','-e','PUBLIC_HOST=entrypoint.example','-v',str(root/name)+':/etc/caddy/Caddyfile:ro','--entrypoint','caddy',caddy,'adapt','--config','/etc/caddy/Caddyfile'])
print('PASS: actual nonroot setup entrypoint and both Caddy bind-mounted configurations; synthetic secrets discarded')
