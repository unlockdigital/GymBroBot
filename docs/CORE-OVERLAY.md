# Core and private deployment

The core is the shared application: user interfaces, workout storage and migrations, planner, agent contract, generic tests and documentation. A private overlay is a separate repository or controlled directory containing deployment settings, owner preferences, private integration adapters and operational records. Personal records and credentials stay outside source control.

A deployment records one reviewed core commit and built image digest, its overlay revision, schema version, backup reference and rollback image. Recording that version is called pinning. It lets an operator identify what is running and restore the preceding known version. The current live private app remains on its existing deployment while this transition is prepared.

## A daily improvement reaches the shared app

1. Preserve the current private work and describe the issue with a synthetic regression.
2. Put the reusable change in a clean core branch and review behavior, privacy and redistribution.
3. Run CI and build the candidate images; retain source, image and package evidence.
4. Rehearse the reviewed core plus overlay against a disposable private storage copy. Compare pre-existing rows and verify recovery.
5. Change the private deployment's recorded core/image version with a fresh backup and rollback reference.
6. Publish the reviewed source/tag when the distribution gates pass.

This process is promotion: a tested shared-core version becomes the selected private deployment version, with a recorded update and recovery procedure. Urgent private fixes should receive a tracked general-core patch and synthetic regression before the next normal update.

## Overlay boundary

Keep core files unchanged in the private deployment. Use declared configuration and extension interfaces. The current compatibility reader can load an absolute owner-controlled 0600 private preparation/catalog hook with an explicit SHA256 digest. Its metadata, injury/PT material and private media are excluded from the public tree. Unknown exercise equipment remains unknown until confirmed.

Back up and version the hook separately with its digest; the generic database backup does not package arbitrary extension files. Record extension contracts and schema compatibility. New core migrations must preserve the private source data until a tested migration is deliberately adopted.

Run `python3 scripts/verify-core-pin.py /path/to/core /private/path/pin.json` using `docs/PRIVATE-PIN.example.json` as the shape. Placeholder values fail. The current check verifies the exact core HEAD, an immutable image reference and a clean checkout. Private overlay contents and actual image/source correspondence need their own evidence; this script alone does not establish them.

## Repository transition

Keep the original repository private while staging the independent clean history in an empty private repository. Audit every published ref/object, metadata and distribution artifact before changing visibility. The existing repository also has old PR pages and Actions records, which require separate review if it is reused.

Choose distinct repository names for the private archive and public source. A case-only spelling change does not create a separate GitHub repository identity. If the public repository takes over the existing name, first update old remotes/automation so private branches cannot be pushed into the new destination through that name. Rename/archive/cutover operations remain a separate deliberate release action.

The public [project history](PROJECT-HISTORY.md) can preserve the development timeline while private records stay in the archive. Additional historical commits require their own content, metadata and rights review.
