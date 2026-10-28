# Privacy

The deployment owner controls the server that stores workout, exercise-catalog and authentication data in SQLite. The release is designed for one enrolled owner. Server administrators, Docker administrators and the authorized agent execution environment are trusted parts of that deployment.

## Data flows

| Operation | Data and destination | Owner control |
|---|---|---|
| Online app use | Browser sends workout and account requests to the selected deployment | Owner selects the hostname/server and logs in |
| Offline workout access | Consented device retains workout snapshot and queued changes | Explicit offline consent, identity gate, logout/discard and recovery controls |
| Agent connection | Scoped training context and proposed plans go to the authorized agent client; conversation content may go to its model provider | Separate application credential, expiry/revocation, bounded context and conversational approval |
| Public HTTPS | Proxy contacts the certificate authority for the configured public hostname | Hosting configuration and certificate storage |
| Build/update | Build tools download pinned source and dependency artifacts from their referenced registries | Operator initiates the build and records the resulting image |
| Backup/recovery export | Databases/configuration or selected device state go to owner-selected storage | Operator backup procedure or authenticated/consented recovery controls |

The app image uses no external network in the supported Compose topology. The default telemetry adapter is a no-op. The current public core excludes private wearable/laboratory providers, Telegram and external exercise media. Additional private extensions have their own data-flow review.

## Agent disclosure

Default context is bounded training history and compact exercise metadata, with owner scope, completeness diagnostics and free-text redaction. It omits private preparation hooks, injury notes and credentials. Current constraints still need explicit confirmation in conversation; do not assume a clinical feed has been read. Inspect the context and choose a provider whose terms/settings suit the data you authorize.

The agent credential authorizes its scope for the enrolled account. Direct save trusts the agent's report of approval; holding the credential is a capability. App logout/recovery or explicit CLI revocation ends existing agent access. SSH authorization is managed separately. A coding agent with broader local administrator access may be able to read other local files; keep its workspace and authority scoped appropriately.

## Retention and recovery

SQLite storage, application backups, device snapshots and recovery exports are plaintext. Protect the host and device and use encrypted off-host backup storage. Browser offline consent controls access behavior and retention; it does not encrypt the browser data. Explicitly resolve pending changes before logout/discard or rollback.

Keep recovery capabilities, setup output and credential files private. Restore can revive older credentials, so rotate restored owner generations and re-pair agents before reopening public access. Arbitrary private hook files, provider credentials and certificate volumes require separate backup coverage from the generic database backup.

The maintainer receives information only when the owner deliberately shares it for support or contributions. Use synthetic examples in public issues. Review the exact release's data flows after adding integrations or changing hosting topology.
