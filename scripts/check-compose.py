"""Validate the resolved, checked-in Compose serving controls without a daemon."""
import json
from pathlib import Path
import subprocess
import sys


def validate(config):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    services = config.get('services', {})
    for name in ('app', 'caddy', 'agent-proxy'):
        service = services.get(name, {})
        require(service.get('tmpfs') == ['/tmp:mode=1777,size=16m'],
                name + ': one absolute tmpfs destination with the size option required')
        require(service.get('read_only') is True, name + ': read-only root required')
        require(service.get('cap_drop') == ['ALL'], name + ': dropped capabilities required')
        require('no-new-privileges:true' in service.get('security_opt', []),
                name + ': no-new-privileges required')
    app = services['app']
    require(app.get('network_mode') == 'none' and not app.get('ports'),
            'app: no application network or published ports allowed')
    require(not app.get('cap_add') and not app.get('privileged'),
            'app: additional privileges prohibited')
    require(app.get('user') in (None, '1000', '1000:1000'),
            'app: image nonroot user must be preserved')
    for name in ('caddy', 'agent-proxy'):
        require(services[name].get('user') == '1000:1000', name + ': nonroot proxy required')
        require(services[name].get('cap_add') == ['NET_BIND_SERVICE'],
                name + ': only bind capability allowed')
    ports = services['agent-proxy'].get('ports', [])
    require(len(ports) == 1 and ports[0].get('host_ip') == '127.0.0.1'
            and ports[0].get('target') == 9443 and str(ports[0].get('published')) == '9443',
            'agent-proxy: exact loopback-only listener required')
    require(services['init'].get('user') == '0:0'
            and services['init'].get('command') == ['init-volumes'],
            'init: fixed operator-only initialization required')
    return {'resolvedCompose': 'pass', 'tmpfsDestinations': 3,
            'appNetwork': 'none', 'agentListener': 'loopback'}


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(['docker', 'compose', '--env-file', '.env.example',
                             'config', '--format', 'json'], cwd=root,
                            text=True, capture_output=True)
    if result.returncode:
        raise SystemExit('Compose configuration could not be resolved')
    try:
        print(json.dumps(validate(json.loads(result.stdout)), sort_keys=True))
    except (ValueError, KeyError, TypeError) as error:
        raise SystemExit(str(error))
