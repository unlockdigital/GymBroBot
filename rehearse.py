import subprocess as sp,pathlib,uuid,time,json,tempfile,shutil,os
r=pathlib.Path(__file__).resolve().parent;n='gymbro-integrated-'+uuid.uuid4().hex[:8];vols=[n+'-'+x for x in ['data','socket','backup','ca','cc','agent-socket','restore']];cs=[];out=[];tmp=pathlib.Path(tempfile.mkdtemp(dir=r,prefix='synthetic-'))
image=os.environ.get('GYMBRO_APP_IMAGE','gymbro-vps-agent:security-20261027');caddy=os.environ.get('GYMBRO_CADDY_IMAGE','gymbro-caddy:security-20261027')
def run(*a,input=None,ok=True):
 p=sp.run(['docker',*a],input=input,text=True,capture_output=True)
 if ok and p.returncode:raise RuntimeError('Docker '+a[0]+' failed: '+p.stderr[-1500:])
 return p
mount=['-v',vols[0]+':/app/data','-v',vols[1]+':/run/gymbro','-v',vols[2]+':/backups','-v',vols[5]+':/run/gymbro-agent']
def task(*a,input=None,extra=[]):return run('run','--rm','--network','none',*mount,*extra,image,*a,input=input)
def start(selected=None):
 selected_mount=[selected if x==vols[0]+':/app/data' else x for x in mount] if selected else mount
 c=n+'-app-'+str(len(cs));cs.append(c);run('run','-d','--name',c,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','-e','TZ=America/Chicago',*selected_mount,image)
 for _ in range(30):
  if run('exec',c,'node','-e',"const r=require('http').get({socketPath:'/run/gymbro/app.sock',path:'/auth/status',headers:{Host:'workouts.example.com','X-Gymbro-Client-IP':'192.0.2.10','X-Forwarded-Proto':'https'}},s=>process.exit(s.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.setTimeout(1000,()=>process.exit(1));",ok=False).returncode==0:return c
  time.sleep(.2)
 raise RuntimeError('App startup: '+run('logs',c,ok=False).stderr[-1500:])
def test(mode=None,input=None):
 return run('run','--rm','-i','--network','container:'+proxy,'-e','TZ=America/Chicago',*mount,'-v',str(r/'test.cjs')+':/test.cjs:ro','--entrypoint','node',image,'/test.cjs',*([mode] if mode else []),input=input)
try:
 run('network','create',n+'-private')
 for v in vols:run('volume','create',v)
 # Initialize only disposable volumes with the base routine plus agent CA directories.
 run('run','--rm','--network','none','--user','0:0',*mount,'-v',vols[3]+':/data','-v',vols[4]+':/config','--entrypoint','sh',image,'-c','chown 1000:1000 /app/data /run/gymbro /run/gymbro-agent /backups /data /config; chmod 700 /app/data /run/gymbro /run/gymbro-agent /backups /data /config; mkdir /data/caddy /config/caddy; chown 1000:1000 /data/caddy /config/caddy')
 claim=task('setup',extra=['-e','PUBLIC_ORIGIN=https://workouts.example.com']).stdout.strip().split()[-1]
 app=start();proxy=n+'-proxy';cs.append(proxy)
 run('run','-d','--name',proxy,'--network',n+'-private','--user','1000:1000','--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges','--tmpfs','/tmp','-p','127.0.0.1::9443','-v',str(r/'Caddyfile.agent')+':/etc/caddy/Caddyfile:ro','-v',vols[5]+':/run/gymbro-agent:ro','-v',vols[3]+':/data','-v',vols[4]+':/config',caddy)
 for _ in range(40):
  p=run('cp',proxy+':/data/caddy/pki/authorities/local/root.crt',str(tmp/'root.crt'),ok=False)
  if p.returncode==0:break
  time.sleep(.2)
 else:raise RuntimeError('Private proxy startup: '+run('logs',proxy,ok=False).stderr[-1500:])
 test('enroll',claim)
 blocked=run('run','--rm','--network','none',*mount,image,'pair',ok=False);assert blocked.returncode!=0 and 'BlockingIOError' in blocked.stderr
 blocked=run('run','--rm','--network','none',*mount,image,'recover-local',input='{}',ok=False);assert blocked.returncode!=0 and blocked.stderr=='Recovery failed\n'
 run('stop',app)
 # Extract only the public CA; pairing output stays in the disposable data volume.
 run('run','--rm','--user','0:0','-v',str(tmp)+':/pairing','--entrypoint','sh',image,'-c','chmod 755 /pairing; chmod 644 /pairing/root.crt')
 task('pair',extra=['-v',str(tmp)+':/pairing:ro']);app=start();out.append(json.loads(test().stdout))
 # Public proxy gets only the app socket. Test public TLS without publishing a domain.
 public=n+'-public';cs.append(public);cfg=tmp/'Caddyfile.public';cfg.write_text((r/'Caddyfile').read_text().replace('{$PUBLIC_HOST} {','workouts.example.com {\n tls internal'));cfg.chmod(0o644)
 run('run','-d','--name',public,'--network','container:'+proxy,'--user','1000:1000','--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges','--tmpfs','/tmp','-e','PUBLIC_HOST=workouts.example.com','-v',str(cfg)+':/etc/caddy/Caddyfile:ro','-v',vols[1]+':/run/gymbro:ro','-v',vols[3]+':/data','-v',vols[4]+':/config',caddy)
 info=json.loads(run('inspect',proxy).stdout)[0];assert all(x['HostIp']=='127.0.0.1' for x in info['NetworkSettings']['Ports']['9443/tcp'])
 import ssl,socket,http.client
 port=int(info['NetworkSettings']['Ports']['9443/tcp'][0]['HostPort']);ctx=ssl.create_default_context(cafile=str(tmp/'root.crt'))
 with ctx.wrap_socket(socket.create_connection(('127.0.0.1',port),timeout=5),server_hostname='agent.gymbro.internal') as conn:
  conn.sendall(b'GET /agent/context HTTP/1.1\r\nHost: agent.gymbro.internal\r\nConnection: close\r\n\r\n');response=http.client.HTTPResponse(conn);response.begin();assert response.status==401;response.read()
 assert not any(x['Destination']=='/run/gymbro-agent' for x in json.loads(run('inspect',public).stdout)[0]['Mounts'])
 time.sleep(.5);test('public');out.append('actual public Caddy TLS: spoofed forwarding headers sanitized; /agent/context denied')
 run('stop',app);task('backup','integrated');
 compare="import pathlib,sqlite3;d=pathlib.Path('/app/data');b=pathlib.Path('/backups/integrated');assert all(list(sqlite3.connect(p).iterdump())==list(sqlite3.connect(b/p.name).iterdump()) for p in d.glob('*.sqlite'));assert not (b/'agent-cli.json').exists()"
 task('-c',compare,extra=['--entrypoint','python3']);out.append('quiescent backup succeeds with credential file excluded; token hashes and receipts retained in control DB')
 # Restore into a new empty volume and read the persisted plans through the app.
 run('run','--rm','--network','none','--user','0:0','-v',vols[6]+':/restore','--entrypoint','sh',image,'-c','chown 1000:1000 /restore; chmod 700 /restore')
 run('run','--rm','--network','none','-v',vols[6]+':/app/data','-v',vols[2]+':/backups',image,'restore','integrated')
 run('run','--rm','--network','none','-v',vols[6]+':/app/data','-v',vols[2]+':/backups','--entrypoint','python3',image,'-c',compare)
 app=start(vols[6]+':/app/data');test('restored');run('stop',app);out.append('empty-volume restore: owner login, exact saved plans/receipts and scoped history passed')
 # Re-pair then owner logout revokes the replacement credential.
 task('-e',"require('fs').unlinkSync('/app/data/agent-cli.json')",extra=['--entrypoint','node']);task('pair',extra=['-v',str(tmp)+':/pairing:ro']);app=start()
 script="const fs=require('fs'),http=require('http');const r=http.request({socketPath:'/run/gymbro/app.sock',path:'/auth/login',method:'POST',headers:{Host:'workouts.example.com','X-Gymbro-Client-IP':'192.0.2.10','X-Forwarded-Proto':'https',Origin:'https://workouts.example.com','Content-Type':'application/json'}},s=>{const cookie=s.headers['set-cookie'][0].split(';')[0];s.resume();s.on('end',()=>{const q=http.request({socketPath:'/run/gymbro/app.sock',path:'/auth/logout',method:'POST',headers:{Host:'workouts.example.com','X-Gymbro-Client-IP':'192.0.2.10','X-Forwarded-Proto':'https',Origin:'https://workouts.example.com',Cookie:cookie,Authorization:'PWA'}},t=>{t.resume();t.on('end',()=>process.exit(t.statusCode===200?0:1));});q.end('{}');});});r.end(JSON.stringify({password:'synthetic-password-123'}));"
 run('exec',app,'node','-e',script)
 p=run('run','--rm','--network','container:'+proxy,*mount,'--entrypoint','node',image,'cli.cjs','context',ok=False);assert p.returncode!=0;out.append('stopped-server re-pair and owner logout generation revocation passed')
finally:
 for c in cs:run('rm','-f',c,ok=False)
 for v in vols:run('volume','rm',v,ok=False)
 run('network','rm',n+'-private',ok=False)
 shutil.rmtree(tmp)
 (r/'test-results.json').write_text(json.dumps({'results':out,'cleanup':all(run('volume','inspect',v,ok=False).returncode!=0 for v in vols)},indent=2)+'\n')
print(json.dumps(out,indent=2))
