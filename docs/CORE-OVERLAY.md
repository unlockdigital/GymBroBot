# Core and private deployment

Keep generic application code, migrations, synthetic regressions, CLI and documentation in this clean core. Keep private configuration, owner datasets, credentials, health/media assets and production evidence in a separate private deployment repository.

Each deployment pins one reviewed core commit and image digest. Record overlay commit, migration version, backup reference and rollback image alongside it. The private overlay supplies configuration/data through declared interfaces; it carries zero edits to core files. CI verifies exact core inventory and hashes against that pin before promotion.

For an improvement discovered in daily use:

1. Preserve the existing private checkout and make a reproducible synthetic regression.
2. Implement the generic fix in a clean core branch; review privacy, rights and behavior.
3. Run core CI and build the immutable image.
4. Rehearse against an isolated copy of private storage and verify existing rows.
5. Update the private core pin through a reviewed promotion with backup and rollback.
6. Publish the reviewed source/tag after distribution gates pass.

An urgent private-only fix gets a tracked extraction item; promotion blocks while the private-only core patch list is nonempty. Owner-specific training preferences remain data/configuration. The current live private application has additional features and remains a separate baseline until parity is demonstrated.

## Existing private history

Preserve the current private repository and its recovery bundle. Establish a fresh independent public history from this reviewed tree. Existing local/remote private commits remain private. Reusing the same GitHub repository name would require an explicit archival/replacement operation and verification of every reachable ref, PR attachment and release artifact before visibility changes. A new public repository provides a clear publication boundary and preserves the existing operational record.
