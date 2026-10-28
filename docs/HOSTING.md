# VPS hosting and recovery

Use a Linux amd64 VPS with Docker Engine and Compose v2, an administrative account and an owner-controlled hostname. The supported Compose topology assumes that public ports 80/443 are available. A VPS already serving other applications needs a reviewed integration with its existing proxy before using these port mappings.

The app uses a private Unix socket and no application network. A public source-built proxy serves the configured hostname. A separate proxy exposes the agent endpoint only at host loopback 9443. The [security baseline](SECURITY-BASELINE.md) and final release evidence define exact versions and accepted advisory dispositions.

## DNS and firewall

Create an A record for the chosen hostname pointing to the VPS address. Add AAAA only after IPv6 routing and firewall behavior are verified. Permit public TCP 80/443 for certificate issuance and application use; restrict administrative SSH under your policy. Keep TCP 9443 inaccessible from the Internet. Inspect provider, host and Docker forwarding rules and test from an external network.

Caddy obtains a public certificate for the configured hostname. Preserve its data/config volumes for renewals. DNS-01 certificate validation proves hostname control; it does not prove external access to the application's HTTPS listener. Verify trusted chain/hostname, expected response, arbitrary-host rejection and public reachability after deployment.

## Build and enroll

Build tools need Internet access to the checksum-pinned source and package registries. Apt security inputs can change; record exact resolved packages and built image digests for the release.

```sh
umask 077
cp .env.example .env
# Set PUBLIC_HOST and OWNER_TIMEZONE in .env.
python3 scripts/prepare-hosting.py
docker compose build init caddy
docker compose run --rm init
docker compose run --rm app setup
docker compose up -d app caddy agent-proxy
```

The preparation step verifies the two public proxy templates and normalizes only their source permissions for nonroot mounts. Keep `.env` and credential files private. Image build checks enforce nonroot access to operations and the active SQLite runtime.

Keep setup output private. Open the trusted HTTPS URL and enroll with the ten-minute setup capability. Save the recovery capability securely and confirm timezone/units. There is one owner per instance and no open registration. If enrollment output is lost, try the password you submitted and use the current-password recovery replacement workflow. Renew an expired unclaimed setup capability with the stopped-app `renew` operation.

After login, create a basic plan or add authored exercise metadata and connect an agent using [agent setup](AGENTS.md). Confirm saved-plan date, prescribed values and a small test workout before relying on the deployment.

## Back up

```sh
(
set -eu
restart_after_backup() {
  backup_status=$?
  trap - EXIT
  docker compose up -d app || exit 1
  exit "$backup_status"
}
trap restart_after_backup EXIT
docker compose stop app
docker compose run --rm app backup YOUR_BACKUP_NAME
)
```

Run maintenance from the current deployment with its recorded image/overlay configuration. Build proposed updates under distinct tags as described in the [upgrade guide](UPGRADING.md). Use a new simple backup name each time. The application lock serializes serving and maintenance. The backup captures owner/workout/control databases and configuration coherently and synchronizes files/directories before reporting success. It excludes the transferable agent bearer file. Preserve that credential separately only under your credential policy.

Backups are plaintext. Arrange encrypted off-host storage, a retention policy and recurring restore rehearsals. Separately preserve public/private proxy data/config volumes while their proxies are stopped: these contain certificate and CA material. Socket volumes are temporary. Private hook files and integration credentials live outside the generic database backup; record and back them up with their digests/configuration.

## Restore into an empty volume

Restrict public ingress to the operator, stop the public proxy/app and retain the original volume. Initialize a new empty destination owned by UID/GID 1000 with mode 0700. Use the same Compose project and the restore override on every later operation against it. Private deployments retain their existing overlay files, mounts and environment options alongside the restore override on every command.

Before running the restore block, restore any required private hook files and retain the matching overlay options. The example covers the public Compose files. Choose an unused volume name; an existing name is rejected before service changes.

```sh
export RESTORE_VOLUME=gymbro-restored
(
set -eu
if docker volume inspect "$RESTORE_VOLUME" >/dev/null 2>&1; then
  echo 'Choose a new, unused restore volume name' >&2
  exit 1
fi
docker compose stop app caddy agent-proxy
GYMBRO_APP_IMAGE=$(docker compose images -q app)
test -n "$GYMBRO_APP_IMAGE"
# Confirm this local immutable image ID matches the selected release before continuing.
docker volume create "$RESTORE_VOLUME"
docker run --rm --network none --user 0:0 --entrypoint sh \
  -v "$RESTORE_VOLUME:/restore" "$GYMBRO_APP_IMAGE" \
  -c 'chown 1000:1000 /restore && chmod 700 /restore'
docker compose -f compose.yaml -f restore.override.example.yaml run --rm app restore YOUR_BACKUP_NAME
docker compose -f compose.yaml -f restore.override.example.yaml up -d app caddy
)
```

Keep the agent proxy stopped throughout restoration and owner generation rotation. Retain `RESTORE_VOLUME` and the override for subsequent commands. Inspect actual selected mounts and verify integrity, owner login, history, plans and receipts before accepting restoration. Restore any required private hook at its configured path and verify its recorded digest. Interrupted restore requires another empty destination.

An older backup can revive old credentials and generations. Before reopening public ingress, rotate the restored owner recovery/session generation and provision new agent access; reconcile newer workout data and browser outboxes. Keep the original volume and rollback image until the restored instance is accepted. Avoid deleting retained volumes as a cleanup shortcut.

## Recovery and limits

The browser supports capability-based password recovery and current-password replacement of a lost recovery capability. Both stopped-app console input modes use private stdin and the application lock; keep secrets out of shell arguments/history/logs.

- `currentPassword` plus `replacementSecret`: choose and retain a 43-character base64url replacement generated from 32 random bytes before execution. This current-password path uses a persistent console-password quota and returns only success status, so a lost response can be retried with the retained password/replacement.
- `secret` plus `password`: supply the existing recovery capability and a new owner password. This path returns a newly generated recovery capability privately; it uses the capability proof rather than the console-password quota. If that response is lost, use the newly selected password with the current-password replacement path to recover the capability.

Do not apply the pre-retained replacement/quota guarantee to the legacy capability/password path. Keep successful legacy stdout private and store its returned capability securely.

Process-interruption and transactional rollback tests cover software crash recovery. Hardware power loss and host reboot need deployment-specific evidence. Linux arm64, native Safari/iOS installation and a shared-host production-proxy integration are separate support claims. See [release status](RELEASE-STATUS.md) for the exact current acceptance scope.
