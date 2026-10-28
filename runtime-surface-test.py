"""Inventory-only checks for the container's bounded operations surface."""
import ast
import importlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

ops = Path('/app/ops.py')
tree = ast.parse(ops.read_text())
imports = sorted({n.name.split('.')[0] for node in ast.walk(tree)
                  if isinstance(node, ast.Import) for n in node.names})
assert not any(isinstance(n, ast.ImportFrom) for n in ast.walk(tree))
assert imports == sorted(['os', 'sys', 'fcntl', 'subprocess', 'sqlite3', 'json',
                          'shutil', 'tempfile', 'pathlib', 'signal', 'stat'])
for name in imports:
    importlib.import_module(name)
unused = ['ssl', '_ssl', 'asyncio', 'html', 'xml', 'pyexpat', '_elementtree', 'tarfile']
assert all(name not in sys.modules for name in unused)
removed = ['mount', 'umount', 'nsenter', 'infocmp']
assert all(shutil.which(name) is None for name in removed)
assert not list(Path('/usr').rglob('systemd-homed'))
assert not list(Path('/usr').glob('**/Archive/Tar.pm'))
assert not Path('/usr/local/lib/node_modules/npm').exists()
assert sqlite3.sqlite_version == '3.53.4'
assert os.environ['LD_LIBRARY_PATH'] == '/opt/sqlite/lib'
assert os.getuid() == 1000
# The container grants no privilege to the serving operations process.
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert int(status['CapEff'].strip(), 16) == 0
assert status['NoNewPrivs'].strip() == '1'
assert not Path('/var/run/docker.sock').exists()
print(json.dumps({'operationsImports': imports, 'excludedTransitiveImports': unused,
                  'removedCommands': removed, 'pythonSQLite': sqlite3.sqlite_version,
                  'uid': os.getuid(), 'capEff': status['CapEff'].strip(),
                  'noNewPrivileges': True, 'homedAbsent': True, 'archiveTarAbsent': True}))
