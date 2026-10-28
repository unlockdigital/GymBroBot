#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
IMAGE=gymbro-vps-agent:security-20261027
PROXY_IMAGE=gymbro-caddy:security-20261027
export GYMBRO_APP_IMAGE="$IMAGE" GYMBRO_CADDY_IMAGE="$PROXY_IMAGE"
python3 compose-config-test.py
python3 scripts/check-compose.py
python3 scripts/check-security-baseline.py
python3 hosting-permissions-test.py
python3 ci-diagnostics-test.py
python3 scripts/prepare-hosting.py
python3 scripts/run-stage.py hardening-build hardening-build.log docker build -f Dockerfile -t "$IMAGE" .
python3 scripts/run-stage.py patched-proxy-build patched-proxy-build.log docker build -f Dockerfile.proxy -t "$PROXY_IMAGE" .
python3 entrypoint-test.py "$IMAGE"
python3 scripts/run-stage.py runtime-surface runtime-surface.log docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -v "$PWD/runtime-surface-test.py:/test.py:ro" --entrypoint python3 "$IMAGE" /test.py
python3 scripts/run-stage.py hardening-unit hardening-unit.log docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/hardening.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs
python3 scripts/run-stage.py durability-test durability-test.log docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 --tmpfs /backups:uid=1000,gid=1000,mode=0700 -v "$PWD/durability-test.py:/test.py:ro" --entrypoint python3 "$IMAGE" /test.py
python3 scripts/run-stage.py provision-test provision-test.log docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/provision-test.cjs:/test.cjs:ro" -v "$PWD/synthetic-ca.crt:/pairing/root.crt:ro" --entrypoint node "$IMAGE" /test.cjs
python3 scripts/run-stage.py agent-unit agent-unit.log docker run --rm --network none -v "$PWD/unit.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs
python3 scripts/run-stage.py history-unit history-unit.log docker run --rm --network none -v "$PWD/history-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs
python3 scripts/run-stage.py hardening-rehearsal hardening-rehearsal.log python3 rehearse.py
docker image inspect "$IMAGE" --format '{{json .Id}}' > hardening-image-ids.txt

python3 scripts/run-stage.py recovery-test recovery-test.log docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/recovery-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs
python3 scripts/run-stage.py sanitization-test sanitization-test.log docker run --rm --network none --tmpfs /app/data:uid=1000,gid=1000,mode=0700 -v "$PWD/sanitization-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs

# Exact custom prescription, slot/transaction policy and source rest behavior.
printf '%s\n' 'Running proposal regression suite'
python3 scripts/run-stage.py proposal-test proposal-test.log docker run --rm --network none -v "$PWD/proposal-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs
printf '%s\n' 'Running slot-policy regression suite'
python3 scripts/run-stage.py slot-policy-test slot-policy-test.log docker run --rm --network none -v "$PWD/slot-policy-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs
printf '%s\n' 'Running rest-policy regression suite'
python3 scripts/run-stage.py rest-policy-test rest-policy-test.log docker run --rm --network none -v "$PWD/rest-policy-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs

printf '%s\n' 'Running authenticated receipt UI suite'
python3 scripts/run-stage.py receipt-ui-test receipt-ui-test.log docker run --rm --network none -v "$PWD/receipt-ui-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs

python3 scripts/run-stage.py rich-workout-test rich-workout-test.log docker run --rm --network none -v "$PWD/rich-workout-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs

python3 scripts/run-stage.py assisted-history-test assisted-history-test.log docker run --rm --network none -v "$PWD/assisted-history-test.cjs:/test.cjs:ro" --entrypoint node "$IMAGE" /test.cjs

# Exercise the actual base Compose topology with synthetic disposable state.
python3 scripts/run-stage.py actual-compose-smoke actual-compose-smoke.log \
  python3 -B compose-smoke-test.py \
  --image "$(docker image inspect --format '{{.Id}}' "$IMAGE")" \
  --proxy-image "$(docker image inspect --format '{{.Id}}' "$PROXY_IMAGE")"
