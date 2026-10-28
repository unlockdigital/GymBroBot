"""Rehearse built images through disposable Compose; synthetic state, internal TLS, loopback only."""
from pathlib import Path
import argparse, sys, subprocess as sp, json, os, hashlib, time, ssl, socket, http.client, secrets, tempfile, shutil, uuid, re, importlib.util
sys.dont_write_bytecode=True
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--image',required=True);p.add_argument('--proxy-image',required=True)
p.add_argument('--source',type=Path,default=Path(__file__).resolve().parent)
p.add_argument('--evidence-dir',type=Path)
a=p.parse_args();C=a.source.resolve();R=Path(tempfile.mkdtemp(prefix='gymbro-compose-smoke-'));E=R/'evidence';E.mkdir()
PROJECT='gymbro-compose-smoke-'+uuid.uuid4().hex[:12]
APP=a.image;PROXY=a.proxy_image;CRED=PROJECT+'-credential'
out={'status':'FAIL','project':PROJECT,'realDataAccessed':False,'integration':[]};stage='preflight'
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def write(n,v):(E/n).write_text(json.dumps(v,indent=2)+'\n')
def require(v,m):
    if not v:raise ValueError(m)
def run(args,input=None,timeout=180,ok=True,env=None,cwd=C):
    p=sp.run(args,input=input,capture_output=True,timeout=timeout,cwd=cwd,env=env)
    if ok and p.returncode:
        out['failedCommandPrefix']=args[:3]
        out['diagnostics']=[line for line in p.stderr.decode(errors='replace').splitlines() if line.startswith(('Error response from daemon:','Synthetic integration assertion failed phase=','Error: Cannot find module','docker: Error response from daemon:','node:internal/')) or line.strip().startswith('at ')]
        raise RuntimeError('Command failed '+str(args[:3])+' stderr sha256='+hashlib.sha256(p.stderr).hexdigest())
    return p
def docker(*args,**kw):return run(['docker',*args],**kw)
def suite(name,args,timeout=240):
    p=run(args,timeout=timeout); b=p.stdout+p.stderr
    (E/(name+'.log')).write_bytes(b)
    row={'name':name,'exit':p.returncode,'outputSha256':hashlib.sha256(b).hexdigest()}
    out['suites'].append(row);write('progress.json',{'stage':stage,'lastSuite':name})
    return p
env=dict(os.environ,PUBLIC_HOST='workouts.example.com',OWNER_TIMEZONE='America/Chicago',CADDY_IMAGE=PROXY,COMPOSE_PROJECT_NAME=PROJECT)
base=['docker','compose','--project-name',PROJECT,'--project-directory',str(C),'-f',str(C/'compose.yaml')]
active=[]
def compose(*args,input=None,ok=True,files=None):
    extra=active if files is None else files
    return run(base+sum((['-f',str(x)] for x in extra),[])+list(args),input=input,ok=ok,env=env)
def cid(s):return compose('ps','--all','-q',s).stdout.decode().strip()
def inspect(s):return json.loads(docker('inspect',cid(s)).stdout)[0]
def wait_app():
    for _ in range(80):
        p=docker('exec',cid('app'),'node','-e',"const r=require('http').get({socketPath:'/run/gymbro/app.sock',path:'/auth/status',headers:{Host:'workouts.example.com','X-Gymbro-Client-IP':'192.0.2.10','X-Forwarded-Proto':'https'}},s=>process.exit(s.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.setTimeout(1000,()=>process.exit(1));",ok=False)
        if p.returncode==0:return
        time.sleep(.2)
    raise RuntimeError('App readiness timeout')
def helper(script=None,args=None,input=None,network='none',credential=None):
    # Exact task-scoped volume names; Compose creates these from the base declarations.
    ds=RESTORE if restore else PROJECT+'_data'
    a=['run','--rm','--label','gymbro.final='+PROJECT,'--network',network,'--read-only','--cap-drop','ALL',
       '--security-opt','no-new-privileges','--memory','512m','--cpus','0.5','--pids-limit','128',
       '--tmpfs','/tmp:mode=1777,size=16m','-v',ds+':/app/data','-v',PROJECT+'_socket:/run/gymbro',
       '-v',PROJECT+'_agent_socket:/run/gymbro-agent','-v',PROJECT+'_backups:/backups']
    if input is not None:a+=['-i']
    if credential:a+=['-v',CRED+':/retained:ro','-e','GYMBRO_AGENT_CREDENTIAL=/retained/agent-cli.json']
    if script is not None:a+=['--entrypoint','node',APP,'-e',script]
    else:a+=['-v',str(C/'test.cjs')+':/test.cjs:ro','--entrypoint','node',APP,'/test.cjs',*(args or [])]
    return docker(*a,input=input)
def cert(service):
    dest=R/(service+'-root.crt')
    for _ in range(80):
        if docker('cp',cid(service)+':/data/caddy/pki/authorities/local/root.crt',str(dest),ok=False).returncode==0:
            dest.chmod(0o644);return dest
        time.sleep(.2)
    raise RuntimeError('CA readiness timeout '+service)
def request(service,path,body=None,headers=None):
    meta=inspect(service);target='443/tcp' if service=='caddy' else '9443/tcp'
    binding=meta['NetworkSettings']['Ports'][target][0]
    require(binding['HostIp']=='127.0.0.1','Host loopback required')
    host='workouts.example.com' if service=='caddy' else 'agent.gymbro.internal'
    ctx=ssl.create_default_context(cafile=str(R/(service+'-root.crt')))
    b=json.dumps(body).encode() if body is not None else b''
    h={'Host':host,'Connection':'close',**(headers or {})}
    if body is not None:h.update({'Content-Type':'application/json','Content-Length':str(len(b))})
    with ctx.wrap_socket(socket.create_connection(('127.0.0.1',int(binding['HostPort'])),timeout=8),server_hostname=host) as s:
        s.sendall((('POST' if body is not None else 'GET')+' '+path+' HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in h.items())+'\r\n').encode()+b)
        response=http.client.HTTPResponse(s);response.begin();data=response.read()
        return response.status,dict(response.getheaders()),data
RESTORE=PROJECT+'-restore';restore=False
try:
    require(os.uname().sysname=='Linux','Native Linux Docker host required')
    for image in [APP,PROXY]:
        require(re.fullmatch(r'sha256:[a-f0-9]{64}',image),'Supply immutable local image IDs')
        require(json.loads(docker('image','inspect',image).stdout)[0]['Id']==image,'Built image identity')
    out.update(appImage=APP,proxyImage=PROXY)
    out['sourceInputs']={n:sha(C/n) for n in ['compose.yaml','Caddyfile','Caddyfile.agent','test.cjs','scripts/check-compose.py']}
    spec=importlib.util.spec_from_file_location('controls',C/'scripts/check-compose.py');controls=importlib.util.module_from_spec(spec);spec.loader.exec_module(controls)
    baseline=json.loads(compose('config','--format','json',files=[]).stdout);write('compose-base.json',baseline);out['baseControls']=controls.validate(baseline)
    runtime={str(p.relative_to(C/'runtime')):sha(p) for p in (C/'runtime').rglob('*') if p.is_file() and 'node_modules' not in p.parts and 'data' not in p.relative_to(C/'runtime').parts}
    runtime['ops.py']=sha(C/'ops.py')
    code="import sys,json,hashlib,pathlib; names=json.load(sys.stdin); print(json.dumps({n:hashlib.sha256((pathlib.Path('/app')/n).read_bytes()).hexdigest() for n in names}))"
    deployed=json.loads(docker('run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','0.5','--pids-limit','64','--entrypoint','python3',APP,'-c',code,input=json.dumps(sorted(runtime)).encode()).stdout)
    require(deployed==runtime,'Built image and source runtime inputs differ')
    out['runtimeSourceFilesVerified']=len(runtime)
    stage='actual-compose';write('progress.json',{'stage':stage})
    public=R/'Caddyfile.test';public.write_text((C/'Caddyfile').read_text().replace('{$PUBLIC_HOST} {','{$PUBLIC_HOST} {\n tls internal'));public.chmod(0o644)
    override=R/'test.override.yaml'
    text='services:\n'
    for s in ['init','app','caddy','agent-proxy']:
        text+='  '+s+':\n'
        if s in ['init','app']:text+='    image: '+APP+'\n'
        text+='    pull_policy: never\n    restart: "no"\n    mem_limit: 512m\n    cpus: 0.5\n    pids_limit: 128\n    logging: {driver: none}\n'
        if s=='init':text+='    network_mode: none\n'
        if s=='caddy':
            text+='    ports: !override\n      - {target: 80, published: "0", host_ip: 127.0.0.1}\n      - {target: 443, published: "0", host_ip: 127.0.0.1}\n    volumes:\n      - '+str(public)+':/etc/caddy/Caddyfile:ro\n'
        if s=='agent-proxy':text+='    ports: !override\n      - {target: 9443, published: "0", host_ip: 127.0.0.1}\n'
    override.write_text(text);active.append(override)
    effective=json.loads(compose('config','--format','json').stdout);write('compose-effective.json',effective)
    # Base validator fixes production listener 9443; ephemeral host port is the explicit test substitution.
    validated=json.loads(json.dumps(effective));validated['services']['agent-proxy']['ports'][0]['published']='9443'
    out['effectiveComposeControls']=controls.validate(validated)
    for s in ['caddy','agent-proxy']:
        require(all(p['host_ip']=='127.0.0.1' and str(p['published'])=='0' for p in effective['services'][s]['ports']),'Only ephemeral loopback ports')
    compose('run','--rm','--no-deps','init')
    claim=compose('run','--rm','--no-deps','app','setup').stdout.decode().strip().split()[-1]
    require(len(claim)==43,'Private setup capability shape')
    compose('up','-d','--no-build','app','caddy','agent-proxy');wait_app();cert('caddy');ca=cert('agent-proxy')
    helper(args=['enroll'],input=claim.encode(),network='none');claim=None
    # Verify lock prevents maintenance while app serves.
    require(compose('run','--rm','--no-deps','app','pair',ok=False).returncode!=0,'Pair lock')
    require(compose('run','--rm','--no-deps','app','recover-local',input=b'{}',ok=False).returncode!=0,'Recovery lock')
    compose('stop','app')
    pair=['run','--rm','--no-deps','-v',str(ca)+':/pairing/root.crt:ro','app','pair']
    compose(*pair);compose('up','-d','--no-build','app');wait_app()
    # This maintained suite exercises real pinned TLS, commits, retry, receipts and explicit revocation.
    helper(network='container:'+cid('agent-proxy'))
    # Re-pair an active token, then preserve it privately to prove backup revival and generation revocation.
    compose('stop','app')
    compose('run','--rm','--no-deps','--entrypoint','node','app','-e',"require('fs').unlinkSync('/app/data/agent-cli.json')")
    compose(*pair)
    token=True
    docker('volume','create','--label','gymbro.final='+PROJECT,CRED)
    docker('run','--rm','--network','none','--label','gymbro.final='+PROJECT,'--user','0:0','--memory','128m','--cpus','0.5','-v',CRED+':/retained','--entrypoint','sh',APP,'-c','chown 1000:1000 /retained && chmod 700 /retained')
    compose('run','--rm','--no-deps','-v',CRED+':/retained','--entrypoint','node','app','-e',"const fs=require('fs');fs.copyFileSync('/app/data/agent-cli.json','/retained/agent-cli.json');fs.chmodSync('/retained/agent-cli.json',0o600)")
    compose('up','-d','--no-build','app');wait_app()
    # Verify public proxy sanitization using its separate internal CA and real loopback listener.
    require(request('caddy','/auth/status')[0]==200,'Public TLS status')
    require(request('caddy','/agent/context')[0]==404,'Public agent denial')
    for i in range(6):
        status=request('caddy','/auth/login',{'password':'invalid-synthetic-password'},headers={'Origin':'https://workouts.example.com','X-Gymbro-Client-IP':'198.51.100.'+str(i),'X-Forwarded-For':'203.0.113.'+str(i)})[0]
        require(status==(403 if i<5 else 429),'Public proxy dedicated identity sanitization')
    require(request('agent-proxy','/agent/context')[0]==401,'Private unauthenticated denial')
    require(helper(script="require('child_process').execFileSync('node',['/app/cli.cjs','context'],{stdio:'pipe'})",network='container:'+cid('agent-proxy'),credential=token).returncode==0,'Active original token')
    write('compose-inspect-original.json',{s:inspect(s) for s in ['app','caddy','agent-proxy']})
    compose('stop','app');compose('run','--rm','--no-deps','app','backup','synthetic')
    compare="import pathlib,sqlite3;d=pathlib.Path('/app/data');b=pathlib.Path('/backups/synthetic');valid=set(p.name for p in b.iterdir())=={'owner.sqlite','workout.sqlite','control.sqlite','config.json'} and all(list(sqlite3.connect(p).iterdump())==list(sqlite3.connect(b/p.name).iterdump()) for p in d.glob('*.sqlite'));__import__('sys').exit(0 if valid else 1)"
    compose('run','--rm','--no-deps','--entrypoint','python3','app','-c',compare)
    compose('stop','caddy','agent-proxy')
    require(not compose('ps','--status','running','-q','agent-proxy').stdout.strip(),'Agent stopped before restore')
    docker('volume','create','--label','gymbro.final='+PROJECT,RESTORE)
    docker('run','--rm','--label','gymbro.final='+PROJECT,'--network','none','--user','0:0','--memory','128m','--cpus','0.5','-v',RESTORE+':/restore','--entrypoint','sh',APP,'-c','chown 1000:1000 /restore && chmod 700 /restore')
    restore_override=R/'restore.override.yaml';restore_override.write_text('volumes:\n  data:\n    external: true\n    name: '+RESTORE+'\n');active.append(restore_override);restore=True
    effective_restore=json.loads(compose('config','--format','json').stdout);write('compose-restore.json',effective_restore)
    compose('run','--rm','--no-deps','app','restore','synthetic')
    compose('run','--rm','--no-deps','--entrypoint','python3','app','-c',compare)
    compose('up','-d','--no-build','app');wait_app();helper(args=['restored'])
    # Direct private-socket check while proxy remains stopped proves restored token was revived.
    epoch="const fs=require('fs'),D=require('better-sqlite3'),d=new D('/app/data/owner.sqlite');console.log(d.prepare('select generation from lifecycle').get().generation);d.close()"
    gen_before=int(helper(script=epoch).stdout)
    check_auth="const fs=require('fs'),http=require('http'),c=JSON.parse(fs.readFileSync('/retained/agent-cli.json'));const r=http.get({socketPath:'/run/gymbro-agent/agent.sock',path:'/agent/context',headers:{Host:'agent.gymbro.internal','X-Forwarded-Proto':'https',Authorization:'Bearer '+c.token}},s=>{s.resume();s.on('end',()=>console.log(s.statusCode));});r.on('error',()=>process.exit(1))"
    require(helper(script=check_auth,credential=token).stdout.strip()==b'200','Backup revives old agent generation')
    compose('stop','app')
    replacement=secrets.token_urlsafe(32)
    require(json.loads(compose('run','--rm','--no-deps','-T','app','recover-local',input=json.dumps({'currentPassword':'synthetic-password-123','replacementSecret':replacement}).encode()).stdout)['ok'],'Recovery generation rotation')
    replacement=None
    require(not compose('ps','--status','running','-q','agent-proxy').stdout.strip(),'Agent stopped through rotation')
    compose('up','-d','--no-build','app');wait_app()
    gen_after=int(helper(script=epoch).stdout);require(gen_after==gen_before+1,'Exact generation increment')
    require(helper(script=check_auth,credential=token).stdout.strip()==b'401','Old generation revoked before proxy restart')
    compose('up','-d','--no-build','caddy','agent-proxy')
    helper(script="const {spawnSync}=require('child_process');const p=spawnSync('node',['/app/cli.cjs','context'],{stdio:'pipe'});if(p.status===0)process.exit(1)",network='container:'+cid('agent-proxy'),credential=token)
    compose('stop','app');compose(*pair);compose('up','-d','--no-build','app');wait_app()
    helper(script="const {execFileSync}=require('child_process');const c=JSON.parse(execFileSync('node',['/app/cli.cjs','context'],{encoding:'utf8'}));if(!c.scope)process.exit(1)",network='container:'+cid('agent-proxy'))
    for service in ['app','caddy','agent-proxy']:
        m=inspect(service);host=m['HostConfig']
        require(m['Image']==(APP if service=='app' else PROXY),'Actual runtime image identity')
        require(m['Config']['User']=='1000:1000' and host['ReadonlyRootfs'] and host['CapDrop']==['ALL'],'Actual serving user/filesystem/capabilities')
        require(any(v in ['no-new-privileges','no-new-privileges:true'] for v in host['SecurityOpt']) and not host['Privileged'],'Actual no-new-privileges')
        require(host['Tmpfs']=={'/tmp':'mode=1777,size=16m'},'Actual Engine tmpfs destination and options')
        if service=='app':require(host['NetworkMode']=='none' and not host['CapAdd'],'Actual isolated app')
        else:require(all(b['HostIp']=='127.0.0.1' and int(b['HostPort']) not in [80,443,9443] for bs in m['NetworkSettings']['Ports'].values() if bs for b in bs),'Actual ephemeral loopback listeners')
    write('compose-inspect-restored.json',{s:inspect(s) for s in ['app','caddy','agent-proxy']})
    process=json.loads(compose('exec','-T','app','python3','-c',"import os,pathlib,json;s=dict(l.split(':',1) for l in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in l);print(json.dumps({'uid':os.getuid(),'capEff':int(s['CapEff'].strip(),16),'noNewPrivs':s['NoNewPrivs'].strip()}))").stdout)
    require(process=={'uid':1000,'capEff':0,'noNewPrivs':'1'},'Actual kernel serving privilege state')
    out['kernelServingControls']=process
    out['status']='PASS'
    out['checks']=['init','nonroot-setup','app-and-both-proxies','effective-and-actual-tmpfs-controls','stopped-app-pairing','pinned-TLS-commit-retry-readback-revoke','public-header-sanitization','consistent-backup','empty-volume-restore','restored-login-plans-receipts','old-token-revival-with-proxy-stopped','recovery-generation-rotation','old-token-revocation','new-agent-pairing']
    out['generations']={'before':gen_before,'after':gen_after}
except Exception as error:
    out['failureStage']=stage;out['failureType']=type(error).__name__;out['failureMessage']=str(error)
finally:
    for files in [active[:1],active]:
        try:compose('down','--volumes','--remove-orphans',files=files,ok=False)
        except Exception:pass
    for label in ['com.docker.compose.project='+PROJECT,'gymbro.final='+PROJECT]:
        for kind in ['container','volume','network']:
            listed=docker(kind,'ls','-q','--filter','label='+label,ok=False)
            for item in listed.stdout.decode().splitlines():docker(kind,'rm',*(['-f'] if kind=='container' else []),item,ok=False)
    docker('volume','rm',RESTORE,CRED,ok=False)
    out['cleanup']={kind+'Absent':all(not docker(kind,'ls','-q','--filter','label='+label).stdout.strip() for label in ['com.docker.compose.project='+PROJECT,'gymbro.final='+PROJECT]) for kind in ['container','volume','network']}
    out['cleanup']['restoreVolumeAbsent']=bool(docker('volume','inspect',RESTORE,ok=False).returncode)
    out['cleanup']['credentialVolumeAbsent']=bool(docker('volume','inspect',CRED,ok=False).returncode)
    if not all(out['cleanup'].values()):out['status']='FAIL'
    write('result.json',out)
    if a.evidence_dir:
        dest=a.evidence_dir.resolve();require(not dest.exists(),'New evidence directory required');shutil.copytree(E,dest)
    shutil.rmtree(R);out['cleanup']['temporaryDirectoryAbsent']=not R.exists()
print(json.dumps(out,sort_keys=True))
if out['status']!='PASS':raise SystemExit(1)
