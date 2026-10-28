# Security

GymBroBot is a single-owner self-hosted app. The supported topology uses a private application network/socket, a public HTTPS proxy and a separate loopback agent proxy. It uses one-time owner enrollment, signed owner sessions, same-origin write checks, scoped agent credentials, immutable validated drafts, revision checks and durable receipts.

Host root, Docker administrators, explicitly configured private hook code and the authorized agent execution account remain trusted. The direct agent commit capability records the agent's assertion of conversational approval. It does not independently authenticate a human conversation. Restrict the agent credential, execution environment and SSH forwarding principal accordingly.

Read the [security baseline](docs/SECURITY-BASELINE.md), [release status](docs/RELEASE-STATUS.md), [privacy policy](PRIVACY.md) and [hosting/recovery guide](docs/HOSTING.md). Each release records its source commit, image/platform digests, package inventory/SBOM, scan date and advisory dispositions. Accepted findings must retain evidence, an expiry and triggers that invalidate the exception. A scanner suppression alone is not an applicability decision.

Before public launch, the maintainer must enable a private vulnerability-reporting destination and list supported release versions. Use that private channel for vulnerability details. Keep credentials, owner records, recovery exports and production logs out of public issues and PRs. Share synthetic reproductions where possible.

Rotate or revoke exposed credentials. Keep encrypted off-host backups and rehearse restore into an empty volume. Recovery or rollback can change session generations and invalidate agent credentials; old backups require revocation/rotation before public ingress resumes. Keep private extension files and certificate stores in separate backup coverage.

## Supported exposure

Public TCP 80/443 serve the configured application hostname. Agent TCP 9443 remains loopback-only and is reached through the verified restricted tunnel. A shared host proxy requires an explicit reviewed configuration; this Compose package assumes its public ports are available. Test DNS, certificate trust, host/provider/Docker firewall behavior and effective SSH policy for the intended deployment.

Changing the base image, enabling extra Python/system tools, granting privileges or network access, adding import/integration paths or changing private hooks can invalidate a security exception. Re-run the affected tests and advisory review before adopting those changes.
