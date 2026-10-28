# Upgrading and rolling back

Use a reviewed source release and its recorded image/platform evidence. Keep deployment secrets outside the source checkout and retain the current images and private storage until the update is accepted. The current private development instance has not yet adopted this release procedure.

## Keep the instance identity stable

Compose uses its project name to select named volumes and networks. Choose one unique project name for the instance and retain it across release directories, using `COMPOSE_PROJECT_NAME` in the private environment or `docker compose -p YOUR_INSTANCE` consistently. A new directory's default project name can select empty volumes and look like missing history. Inspect resolved configuration and mounts before any maintenance command.

## Prepare an update

1. Read release notes for storage/schema changes, required private-hook versions, browser queue compatibility and advisory expiry.
2. Preserve the current core/overlay commits, image IDs/digests, environment, certificate stores, private hooks and their hashes.
3. Build the new source in a separate clean checkout with distinct image tags selected through a release-specific Compose override. Keep the current deployment configuration on its recorded images while preparing the update. Record the new image digests and package/security evidence; use immutable references for adoption and rollback.
4. Rehearse the core plus required overlay on disposable storage. Verify representative plans, workouts, owner authentication and an empty-volume restore. Keep real records out of public tests/logs.
5. Resolve pending browser changes and take a new quiescent backup using the current deployment. Stop public ingress during any credential-sensitive migration or restore.

## Adopt and verify

Keep the same Compose project and intended volumes. Select the new reviewed application and proxy images through the versioned private deployment configuration. Apply only documented migrations. Verify mounts, owner login, plan/history readback, a harmless workout probe, agent authorization and the deployment's recorded source/image versions before reopening ingress.

A browser may still have the preceding worker and queued work. Preserve it until queue synchronization or deliberate recovery is complete. Use the app's guarded update flow and its compatibility notes; clearing browser storage can destroy unsynced data.

## Roll back

If the new code can safely read the current schema, select the retained prior images and verify them. If storage changed incompatibly, restore the quiescent backup into a new empty volume using the [restore guide](HOSTING.md). Retain the failed/newer volume for reconciliation. Revoke revived old credentials and reconcile newer workouts before accepting rollback.

A rollback is a deliberate version/storage decision. Restoring an old backup without reconciling newer training can discard valid records. The release record should identify the operator, selected core/image/overlay/schema, backup and rollback reference so the state can be reconstructed.
