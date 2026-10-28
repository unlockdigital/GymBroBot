# Agent setup and workout flow

GymBroBot supplies the application connection. Your agent client supplies the model session, account sign-in and tool execution. Subscription eligibility and limits depend on that client/provider. Use a local coding agent with permission to run the CLI. Browser-only chat needs a configured connection to the local tools.

## Private endpoint and credential

The Compose agent proxy listens on VPS loopback 9443 and has its own local certificate authority. It reaches only the agent socket. Agent credentials authorize bounded context, drafts, exact commits, readback and revocation for the enrolled owner. The current provisioning command issues a 24-hour credential; re-pair after expiry or revocation.

Provisioning takes the same exclusive application lock as serving. Run it in a maintenance window with the app stopped. These commands run on the VPS from the Compose directory after enrollment and private proxy startup. The temporary pairing directory contains only the public CA certificate. The credential destination is outside the repository.

```sh
(
set -eu
umask 077
GYMBRO_AGENT_DIR="$HOME/.config/gymbrobot"
install -d -m 700 "$GYMBRO_AGENT_DIR"
test ! -e "$GYMBRO_AGENT_DIR/agent-cli.json"
GYMBRO_PAIR_DIR=$(mktemp -d)
cleanup_pairing() {
  pairing_status=$?
  trap - EXIT
  docker compose up -d app || exit 1
  rm -f "$GYMBRO_PAIR_DIR/root.crt"
  rmdir "$GYMBRO_PAIR_DIR"
  exit "$pairing_status"
}
trap cleanup_pairing EXIT
docker compose cp agent-proxy:/data/caddy/pki/authorities/local/root.crt "$GYMBRO_PAIR_DIR/root.crt"
chmod 755 "$GYMBRO_PAIR_DIR"
chmod 644 "$GYMBRO_PAIR_DIR/root.crt"
docker compose stop app
docker compose run --rm -v "$GYMBRO_PAIR_DIR:/pairing:ro" app pair
docker compose cp app:/app/data/agent-cli.json "$GYMBRO_AGENT_DIR/agent-cli.json"
chmod 600 "$GYMBRO_AGENT_DIR/agent-cli.json"
# The EXIT handler restarts the app and removes only the public CA scratch copy.
)
```

The subshell stops at the first failed command and its exit handler attempts to restart the app. Resolve a failed credential copy before using its destination; never assume a partial file is valid. If the restart fails, restore service explicitly before ending maintenance. An existing credential file is deliberately not overwritten. Revoke or expire the previous credential and remove only that file through an authorized stopped-app maintenance operation before re-pairing. Preserve the databases and proxy certificate volumes.

Transfer the private credential file and `runtime/cli.cjs` to the agent machine over a verified administrative connection, then use the tunnel-only account for regular agent operations. The administrator used for provisioning has broader authority than the agent. Keep the CA trust pinned to the verified server.

The provisioner writes `/app/data/agent-cli.json` with mode 0600 and refuses an existing file. Transfer it privately to the agent machine and keep it in a 0700 configuration directory with mode 0600. Do not put its contents in prompts, command arguments, logs or repository files. Only its filesystem path is supplied to the CLI.

## Restricted SSH

Use a separate tunnel-only principal/key with no application-file or Docker access. Pin the server host key. The tested policy allows local forwarding only to literal `127.0.0.1:9443`, disables sessions/exec/PTY/agent/X11/remote forwarding and restricts accepted keys. Validate effective `sshd -T` output and negative tests on the intended host before granting the key. OpenSSH restricts destinations; SOCKS can also reach the explicitly permitted destination.

A typical client tunnel is:

```sh
ssh -N -T -i /private/path/tunnel-key   -o IdentitiesOnly=yes -o BatchMode=yes   -o StrictHostKeyChecking=yes   -o UserKnownHostsFile=/private/path/verified-known-hosts   -o ExitOnForwardFailure=yes   -L 127.0.0.1:9443:127.0.0.1:9443 gymbro-tunnel@YOUR_VPS
```

Run `runtime/cli.cjs` with Node 22 and `GYMBRO_AGENT_CREDENTIAL` set to the private credential path. A local 9443 port collision must be resolved explicitly; do not silently connect to a different instance.

## Conversation and save

Give the agent [SKILL.md](../SKILL.md). Context contains bounded training data and catalog metadata with completeness diagnostics; current constraints require conversation confirmation. The owner can extend the catalog in the app. Rich schema-v2 proposals retain per-set load mode, load, reps/duration, RPE, rest, types, blocks and groups.

The server validates the proposal and returns a stored canonical draft. The agent shows that exact draft, date, version and digest for approval. After an unambiguous approval, commit saves the stored draft atomically and returns a receipt. Reuse the same idempotency key if a response is lost. Changed context or an occupied/started date requires a fresh decision and draft. Read back the plan and tell the owner which date to open in the app.

Direct commit trusts the agent's report of conversational approval; the credential holder has that capability. Scoped credentials reduce the impact of misuse. The agent execution account and its model provider receive authorized context. App logout/recovery revokes existing credentials through the owner generation. CLI `revoke` ends the current credential. SSH-key revocation is a separate operator action.

## Private overlay

Owner-managed catalog additions are private data in the instance. Existing private plans can use an explicitly configured, owned and digest-checked hook file for private preparation/catalog behavior. Keep that hook and private integrations outside the public repository. Back up and version the hook separately: the generic application backup does not package arbitrary private extension files.
