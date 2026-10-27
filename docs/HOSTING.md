# VPS hosting and recovery

Set an A record for a hostname such as `workouts.example.com` to your VPS address. Add AAAA only with tested IPv6 routing and firewall rules. Caddy serves trusted public HTTPS once DNS, inbound ports 80/443 and certificate issuance work. Keep agent TCP 9443 closed to the Internet; Compose binds it to loopback. Pinned Node 22.23.4/Caddy 2.11.7 and current Debian security repositories have a Linux arm64 build/regression result. Complete the remaining amd64, SBOM/OS scan and deployment gates before exposing this candidate.

```sh
umask 077
cp .env.example .env
# Set PUBLIC_HOST and OWNER_TIMEZONE in .env.
docker compose build init
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
