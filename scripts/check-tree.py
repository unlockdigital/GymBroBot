from pathlib import Path
import hashlib,json,re,sys
root=Path(__file__).resolve().parents[1]
fail=[]
for p in root.rglob('*'):
 rel=p.relative_to(root)
 if '.git' in rel.parts or '__pycache__' in rel.parts:continue
 if p.is_symlink():fail.append(f'{rel}: symlink');continue
 if not p.is_file():continue
 if 'node_modules' in rel.parts:fail.append(f'{rel}: dependency tree');continue
 if p.name in ('.env','agent-cli.json') or p.suffix in ('.sqlite','.db') or any(x in rel.parts for x in ('data','backups','pairing')):fail.append(f'{rel}: private path')
 data=p.read_bytes()
 if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',data):fail.append(f'{rel}: private key')
 if re.search(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{32,})',data):fail.append(f'{rel}: credential pattern')
 if b'/'+b'Users/' in data or b'internal-'+b'artifacts/' in data:fail.append(f'{rel}: private provenance path')
lock=json.loads((root/'runtime/package-lock.json').read_text())
for name,entry in lock['packages'].items():
 if not name:continue
 if not entry.get('resolved','').startswith('https://registry.npmjs.org/') or not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==',entry.get('integrity','')):fail.append(name+': missing official registry SHA512 pin')
m=json.loads((root/'SOURCE-MANIFEST.json').read_text())
for e in m['files']:
 p=root/e['path']
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=e['candidate_sha256']:fail.append(e['path']+': source drift')
if fail:
 print('\n'.join(fail));sys.exit(1)
print(json.dumps({'source_pins':len(m['files']),'bounded_tree_scan':'pass','full_secret_scan':'separate gate'}))
