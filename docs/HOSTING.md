# VPS hosting and recovery

Set an A record for a hostname such as `workouts.example.com` to your VPS address. Add AAAA only with tested IPv6 routing and firewall rules. Caddy serves trusted public HTTPS once DNS, inbound ports 80/443 and certificate issuance work. Keep agent TCP 9443 closed to the Internet; Compose binds it to loopback. The security candidate builds Node22.23.4/Debian13 with active Node/Python SQLite3.53.4 and a source-patched Caddy2.11.7 scratch proxy. See [the security baseline](SECURITY-BASELINE.md) for exact dependencies and verification limits. Complete final image/advisory, merged private-copy and public deployment gates before exposure.

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

Open your HTTPS URL and enroll with the ten-minute setup capability. Retain the recovery capability securely. Confirm the timezone and storage-unit convention. A trusted certificate, external-network reachability, arbitrary-host rejection and effective provider/host firewall behavior are acceptance gates. Docker publishes ports through its own forwarding rules.

Pair your agent using [the skill](../SKILL.md) and a forwarding-only account. Restrict authorized destinations to `127.0.0.1:9443`, disable shell/exec/PTY/remote forwarding, pin the SSH host key, and verify effective sshd policy before use. Keep credentials in a private directory outside the source tree. Administrator/root/Docker access retains broad host authority.

## Backup

```sh
docker compose stop app
docker compose run --rm app backup YOUR_BACKUP_NAME
docker compose up -d app
```

The exclusive lock and SQLite backup produce coherent owner/workout/control databases and configuration with fsync. Backups are plaintext; arrange encrypted off-host retention. Back up both Caddy data/config volumes while the proxies are stopped because they hold certificate and CA material. The agent bearer file is excluded from application backups. Socket volumes are temporary.

## Restore

Restrict public ingress and stop public Caddy/app. Restore into a new empty private volume while retaining the original. Use `restore.override.example.yaml` and `RESTORE_VOLUME` consistently. Initialize UID/GID 1000 ownership and mode 0700 for the destination, then run the app's `restore YOUR_BACKUP_NAME` command through the override. Verify mounted volumes, integrity, owner login, history, plans and receipts. Rotate restored owner recovery/session generations and re-pair agents before reopening ingress. Older backups can revive historical credentials. Reconcile newer workouts and browser outboxes before accepting rollback. Interrupted restoration requires another empty destination.

Linux crash tests cover process interruption and transaction rollback. Hardware power loss, public DNS/ACME and actual host reboot remain separate deployment checks.

Distribution archives may retain mode0600 on public source templates. The hosting preparation command verifies release hashes and makes only Caddyfile/Caddyfile.agent readable as0644 for UID1000 bind mounts. Private .env and agent-cli.json stay0600; unsafe credential modes fail before template changes. Docker explicitly makes public ops.py readable inside the image and validates Python/native SQLite under the runtime UID. The actual-image entrypoint/proxy test exercises setup and both public configurations with synthetic state.
