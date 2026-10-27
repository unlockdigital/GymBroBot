#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
IMAGE=gymbro-vps-agent:recovery-sanitized-20261027
python3 hosting-permissions-test.py
python3 scripts/prepare-hosting.py
docker build -f Dockerfile -t "$IMAGE" . > hardening-build.log 2>&1
python3 entrypoint-test.py "$IMAGE"
docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/hardening.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > hardening-unit.log 2>&1
docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 --tmpfs /backups:uid=1000,gid=1000,mode=0700 -v "$PWD/durability-test.py:/test.py:ro" --entrypoint python3 "$IMAGE" /test.py > durability-test.log 2>&1
docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/provision-test.cjs:/test.cjs:ro" -v "$PWD/synthetic-ca.crt:/pairing/root.crt:ro" --entrypoint node "$IMAGE" /test.cjs > provision-test.log 2>&1
docker run --rm --network none -v "$PWD/unit.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > agent-unit.log 2>&1
docker run --rm --network none -v "$PWD/history-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > history-unit.log 2>&1
python3 rehearse.py > hardening-rehearsal.log 2>&1
docker image inspect "$IMAGE" --format '{{json .Id}}' > hardening-image-ids.txt

docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/recovery-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > recovery-test.log 2>&1
docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/sanitization-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > sanitization-test.log 2>&1

# Exact custom prescription, slot/transaction policy and source rest behavior.
printf '%s\n' 'Running proposal regression suite'
docker run --rm --network none -v "$PWD/proposal-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > proposal-test.log 2>&1
printf '%s\n' 'Running slot-policy regression suite'
docker run --rm --network none -v "$PWD/slot-policy-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > slot-policy-test.log 2>&1
printf '%s\n' 'Running rest-policy regression suite'
docker run --rm --network none -v "$PWD/rest-policy-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > rest-policy-test.log 2>&1

printf '%s\n' 'Running authenticated receipt UI suite'
docker run --rm --network none -v "$PWD/receipt-ui-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs > receipt-ui-test.log 2>&1
