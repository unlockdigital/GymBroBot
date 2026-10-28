"""Prove malformed tmpfs and relaxed serving controls fail before build/start."""
import copy
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('compose_policy', Path(__file__).parent / 'scripts/check-compose.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
base = {'services': {
    name: {'tmpfs': ['/tmp:mode=1777,size=16m'], 'read_only': True,
           'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true']}
    for name in ('app', 'caddy', 'agent-proxy')}}
base['services']['app']['network_mode'] = 'none'
for name in ('caddy', 'agent-proxy'):
    base['services'][name].update(user='1000:1000', cap_add=['NET_BIND_SERVICE'])
base['services']['agent-proxy']['ports'] = [{'host_ip': '127.0.0.1', 'target': 9443, 'published': '9443'}]
base['services']['init'] = {'user': '0:0', 'command': ['init-volumes']}
policy.validate(base)
mutations = [
    lambda c: c['services']['app'].update(tmpfs=['/tmp:mode=1777', 'size=16m']),
    lambda c: c['services']['caddy'].update(tmpfs=['/tmp:mode=1777', 'size=16m']),
    lambda c: c['services']['agent-proxy'].update(tmpfs=['/tmp:mode=1777', 'size=16m']),
    lambda c: c['services']['app'].update(network_mode='bridge'),
    lambda c: c['services']['app'].update(user='0:0'),
    lambda c: c['services']['app'].update(cap_add=['SYS_ADMIN']),
    lambda c: c['services']['app'].update(read_only=False),
    lambda c: c['services']['agent-proxy']['ports'][0].update(host_ip='0.0.0.0'),
    lambda c: c['services']['init'].update(command=['serve']),
]
for change in mutations:
    altered = copy.deepcopy(base)
    change(altered)
    try:
        policy.validate(altered)
    except ValueError:
        continue
    raise SystemExit('Unsafe Compose mutation was accepted')
print('PASS: valid resolved configuration and nine unsafe Compose mutations')
