"""Reject setup configuration that bypasses the reviewed security build."""
from pathlib import Path
import json,re,sys

def validate(root):
 env={k:v for line in (root/'.env.example').read_text().splitlines() if line and not line.startswith('#') for k,v in [line.split('=',1)]}
 docker=(root/'Dockerfile').read_text();compose=(root/'compose.yaml').read_text();proxy=(root/'Dockerfile.proxy').read_text()
 node=re.search(r'^ARG NODE_IMAGE=(\S+)$',docker,re.M).group(1)
 assert re.fullmatch(r'node@sha256:[a-f0-9]{64}',node)
 assert env['NODE_IMAGE']==node and '${NODE_IMAGE:-'+node+'}' in compose,'Setup overrides reviewed Node baseline'
 assert env['CADDY_IMAGE']=='gymbro-caddy:security-20261027' and '${CADDY_IMAGE:-'+env['CADDY_IMAGE']+'}' in compose,'Setup overrides patched source proxy'
 assert 'dockerfile: Dockerfile.proxy' in compose and compose.count('pull_policy: never')==2
 assert re.search(r'^ARG GO_IMAGE=golang@sha256:[a-f0-9]{64}$',proxy,re.M)
 lock=json.loads((root/'runtime/package-lock.json').read_text());pkg=json.loads((root/'runtime/package.json').read_text())
 assert pkg['dependencies']['better-sqlite3']=='13.0.3' and lock['packages']['node_modules/better-sqlite3']['version']=='13.0.3'
 for name,p in lock['packages'].items():
  if name:assert p.get('resolved','').startswith('https://registry.npmjs.org/') and re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==',p.get('integrity',''))
 source=json.loads((root/'proxy/source-pins.json').read_text());assert source['go_toolchain']=='go1.26.10' and source['x_net']=='v0.60.0' and source['chi']=='v5.4.0'
 return {'nodeImage':node,'proxyBuild':'patched source','sqlitePackage':'13.0.3','dependencyPins':len(lock['packages'])-1}
if __name__=='__main__':
 print(json.dumps(validate(Path(__file__).resolve().parents[1]),sort_keys=True))
