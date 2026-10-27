#!/usr/bin/env python3
"""Build pinned public Caddy source and retain notices for compiled modules."""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, os, re, shutil, subprocess, urllib.request, zipfile
p=argparse.ArgumentParser();p.add_argument('--go',default='/usr/local/go/bin/go');p.add_argument('--arch',choices=['amd64','arm64'],default='amd64');p.add_argument('--output',type=Path,default=Path('/output'));a=p.parse_args()
D=Path(__file__).resolve().parent;P=json.loads((D/'source-pins.json').read_text());sha=lambda b:hashlib.sha256(b).hexdigest()
assert subprocess.check_output([a.go,'version'],text=True).split()[2]=='go1.26.10','Pinned Go1.26.10 required'
for f,key in [('patched.go.mod','patched_go_mod_sha256'),('patched.go.sum','patched_go_sum_sha256')]:assert sha((D/f).read_bytes())==P[key]
z=D/'caddy-v2.11.7.zip'
if not z.exists():
 with urllib.request.urlopen('https://proxy.golang.org/github.com/caddyserver/caddy/v2/@v/v2.11.7.zip',timeout=90) as r:z.write_bytes(r.read())
assert sha(z.read_bytes())==P['source_zip_sha256'];src=D/'source';assert not src.exists(),'Fresh build directory required';src.mkdir()
with zipfile.ZipFile(z) as ar:
 prefix='github.com/caddyserver/caddy/v2@v2.11.7/'
 for m in ar.infolist():
  assert m.filename.startswith(prefix) and '..' not in PurePosixPath(m.filename).parts and ((m.external_attr>>16)&0o170000)!=0o120000
  rel=m.filename[len(prefix):]
  if not rel:continue
  target=src/rel
  if m.is_dir():target.mkdir(parents=True,exist_ok=True)
  else:target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(ar.read(m));target.chmod(0o644)
for f,out in [('patched.go.mod','go.mod'),('patched.go.sum','go.sum')]:shutil.copyfile(D/f,src/out)
env={k:v for k,v in os.environ.items() if k in ['PATH','TMPDIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY']};env.update({'GOENV':'off','GOTOOLCHAIN':'local','GOPROXY':'https://proxy.golang.org','GOSUMDB':'sum.golang.org','GOPATH':'/tmp/proxy-gopath','GOMODCACHE':'/tmp/proxy-modules','GOCACHE':'/tmp/proxy-cache','GOMAXPROCS':'2','GOMEMLIMIT':'512MiB','GOGC':'50','GOFLAGS':'-p=2','CGO_ENABLED':'0','GOOS':'linux','GOARCH':a.arch})
run=lambda *v:subprocess.run([a.go,*v],cwd=src,env=env,check=True)
run('mod','download');run('mod','verify');out=a.output;assert not out.exists();(out/'usr/bin').mkdir(parents=True)
run('build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid= -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.7-gymbro-security.20261027','-o',str(out/'usr/bin/caddy'),'./cmd/caddy')
text=subprocess.check_output([a.go,'list','-deps','-json','./cmd/caddy'],cwd=src,env=env,text=True);dec=json.JSONDecoder();i=0;mods={};packages=[]
while i<len(text):
 while i<len(text) and text[i].isspace():i+=1
 if i==len(text):break
 item,i=dec.raw_decode(text,i);packages.append(item['ImportPath']);m=item.get('Module')
 if m:mods[m['Path']]=m
assert 'golang.org/x/crypto/openpgp' not in packages;assert 'golang.org/x/crypto/x509roots/fallback' in packages
notices=[];inventory=[]
for name,m in sorted(mods.items()):
 files=[]
 for f in sorted(Path(m['Dir']).iterdir()):
  if f.is_file() and re.match(r'(?i)^(license|licence|copying|notice|copyright)(\.|$)',f.name):
   b=f.read_bytes();files.append({'file':f.name,'sha256':sha(b)});notices.append(f'## {name} {m.get("Version","v2.11.7+security-patches")} / {f.name}\n\n'+b.decode(errors='replace'))
 assert files,'Missing dependency license for '+name
 inventory.append({'module':name,'version':m.get('Version','v2.11.7+security-patches'),'sum':m.get('Sum'),'license_files':files})
licenses=out/'usr/share/licenses/caddy';licenses.mkdir(parents=True)
shutil.copyfile(src/'LICENSE',licenses/'LICENSE');shutil.copyfile(Path(a.go).resolve().parents[1]/'LICENSE',licenses/'GO-LICENSE')
(licenses/'THIRD_PARTY_NOTICES.md').write_text('# Compiled Caddy dependency notices\n\nModified Caddy2.11.7: Go1.26.10, x/net0.60.0 and chi5.4.0. Preserve all notices.\n\n'+'\n\n'.join(notices))
(licenses/'modules.json').write_text(json.dumps(inventory,indent=2)+'\n');(licenses/'build.json').write_text(json.dumps({'source':P,'arch':a.arch,'compiled_packages':packages,'binary_sha256':sha((out/'usr/bin/caddy').read_bytes())},indent=2)+'\n')
for d in ['data','config','tmp','etc/caddy']:(out/d).mkdir(parents=True,exist_ok=True)
(out/'tmp').chmod(0o1777)
for d in ['data','config']:(out/d).chmod(0o700);os.chown(out/d,1000,1000)
print(json.dumps({'modules':len(inventory),'architecture':a.arch,'binary_sha256':sha((out/'usr/bin/caddy').read_bytes())}))
