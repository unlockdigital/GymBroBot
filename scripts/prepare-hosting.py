"""Make the two public proxy templates readable inside nonroot bind mounts."""
from pathlib import Path
import os,stat,json,hashlib
root=Path(__file__).resolve().parents[1]
manifest={e['path']:e['candidate_sha256'] for e in json.loads((root/'SOURCE-MANIFEST.json').read_text())['files']}
files=[]
for name in ['Caddyfile','Caddyfile.agent']:
 p=root/name;s=p.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid():raise SystemExit('Owned regular public template required')
 if hashlib.sha256(p.read_bytes()).hexdigest()!=manifest.get(name):raise SystemExit('Public template differs from reviewed release')
 files.append(p)
# Validate before changing any public source modes. Credentials keep their private modes.
for name in ['.env','agent-cli.json']:
 p=root/name
 if p.exists() or p.is_symlink():
  s=p.lstat()
  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)&0o077:raise SystemExit('Private credential permissions required')
for p in files:os.chmod(p,0o644,follow_symlinks=False)
print('Public proxy templates ready; private credential modes preserved')
