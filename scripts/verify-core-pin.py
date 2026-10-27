"""Reject private deployment drift from an explicitly pinned core commit."""
import json,re,subprocess,sys
from pathlib import Path
if len(sys.argv)!=3:raise SystemExit('usage: verify-core-pin.py CORE_CHECKOUT PRIVATE_PIN_JSON')
core=Path(sys.argv[1]).resolve();pin=json.loads(Path(sys.argv[2]).read_text())
if set(pin)!={'core_commit','image_digest','overlay_commit'}:raise SystemExit('invalid pin fields')
if not re.fullmatch('[0-9a-f]{40}',pin['core_commit']) or not re.fullmatch('[0-9a-f]{40}',pin['overlay_commit']):raise SystemExit('unreviewed commit pin')
if not re.fullmatch('sha256:[0-9a-f]{64}',pin['image_digest']):raise SystemExit('missing immutable image digest')
def git(*args):return subprocess.check_output(['git','-C',str(core),*args],text=True).strip()
if git('rev-parse','HEAD')!=pin['core_commit']:raise SystemExit('core commit mismatch')
if git('status','--porcelain','--untracked-files=all'):raise SystemExit('core checkout has drift')
if git('rev-list','--max-parents=0','HEAD').count('\n'):raise SystemExit('multiple history roots')
print(json.dumps({'core_commit':pin['core_commit'],'image_digest':pin['image_digest'],'overlay_commit':pin['overlay_commit'],'core_drift':'none'}))
