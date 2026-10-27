"""Synthetic actual-image nonroot entrypoint and public proxy bind-mount checks."""
from pathlib import Path
import subprocess,sys,re
root=Path(__file__).resolve().parent
image=sys.argv[1] if len(sys.argv)>1 else 'gymbro-vps-agent:recovery-sanitized-20261027'
caddy='caddy@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489'
def run(args):
 p=subprocess.run(['docker',*args],capture_output=True,text=True)
 if p.returncode:raise SystemExit('Synthetic image entrypoint/proxy check failed; credential output suppressed')
 return p.stdout
# setup runs the actual configured Python entrypoint as the image's nonroot user.
out=run(['run','--rm','--network','none','--log-driver','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/app/data:uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:mode=1777','-e','PUBLIC_ORIGIN=https://entrypoint.example',image,'setup'])
if not re.fullmatch(r'Private ten-minute enrollment capability: [A-Za-z0-9_-]{43}\n',out):raise SystemExit('Unexpected setup result; credential output suppressed')
out=None
for name in ['Caddyfile','Caddyfile.agent']:
 run(['run','--rm','--network','none','--log-driver','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:mode=1777','-e','PUBLIC_HOST=entrypoint.example','-v',str(root/name)+':/etc/caddy/Caddyfile:ro','--entrypoint','caddy',caddy,'adapt','--config','/etc/caddy/Caddyfile'])
print('PASS: actual nonroot setup entrypoint and both Caddy bind-mounted configurations; synthetic secrets discarded')
