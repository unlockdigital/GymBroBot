# Release status

Status date: October 28, 2026. This is a source preview with completed bounded security, Linux/Compose and automated everyday-use acceptance. The existing private production deployment remains on its current version.

## Completed evidence

- Frozen runtime source `b81df078802b7d2188f00ccec5bb9b35ff1309a6` passed a fresh Linux amd64 build and 24 named checks. The native Node and Python paths use SQLite 3.53.4.
- Actual disposable Compose initialization, owner setup, both proxies, pairing, TLS agent draft/approved commit/retry/readback, backup, empty-volume restore, generation rotation and old-token revocation passed. Effective configuration and actual kernel/mount state were checked. The maintained smoke test repeats this lifecycle in CI with synthetic state.
- The same source passed ten Chromium/WebKit suites and 110 assertion groups, plus 24 assisted-edit regressions. Synced and offline corrections preserve assistance/bodyweight/added-weight semantics. Rich per-set plans, logging, reconnect, storage failures, recovery/logout and worker updates passed. [Browser acceptance](BROWSER-ACCEPTANCE.md) records scope and asset hashes.
- All thirteen high advisory IDs have dated component/code-path decisions for the exact application/proxy images. Four unused vulnerable commands were removed. The raw application scan retains 64 high package rows across those IDs and zero critical rows. The bounded exceptions expire **November 11, 2026**, and changes to the checked execution profile can invalidate them earlier. [Advisory decisions](ADVISORY-DECISIONS.md) and [release evidence](RELEASE-EVIDENCE.json) record the boundary.
- The release verifier passes sixteen controls under ordinary and optimized Python. Invalid images, expired decisions, source drift/symlinks and changed Compose inputs are rejected.
- The selected private-copy rehearsal read legacy plans through the owner-scoped mapper/hooks and preserved every pre-existing application row. Weighted/timed logging, corrections, completion and restart passed. Complete deployed Next.js behavior and private exercise media retain separate coverage.
- Source lineage, generic catalog metadata, generated icons, dependency/proxy notices and the clean source/history have bounded redistribution/privacy reviews. Every new release repeats its final-tree/history and artifact checks.

Subsequent documentation and test-only additions preserve all 78 image inputs in [the build-input record](IMAGE-INPUTS.json). A different source/image/profile requires proportional revalidation. Disposable rehearsal resources were removed and cleanup independently verified.

## Hosting evidence

A disposable real DNS hostname and Let’s Encrypt DNS-01 issuance were verified, along with trusted HTTPS/HTTP2 from the VPS. External access to its temporary 8443 listener timed out. The test certificate was revoked and its resources removed; the owner removed the temporary DNS records.

Isolated Linux OpenSSH tests verified the restricted tunnel and rejected shell/exec/PTY, remote or alternative-destination forwarding and host-key mismatch. A subsequent exact-path fixed-marker experiment passed over trusted public HTTPS on the existing 443 route, then restored the original proxy configuration and normal authentication responses. Public 22/80/443 were reachable from the test client; 8443/9443 timed out. Effective host/provider firewall rules and intended-host restricted SSH policy remain unverified because administrative reads were unavailable. Reachability tests establish the observed behavior at the test time.

Native Safari/iOS installation, Linux arm64 and hardware power-loss behavior remain support limits. Automated WebKit coverage supports the tested browser flows. Physical phone installation is outside this candidate's required automated gate.

## Remaining publication and adoption work

1. Maintain the audited clean source in `unlockdigital/GymBroBot` and its private security-reporting channel. The independent source history and repository metadata were checked; historic GitHub history, PR pages and Actions records remain in the separately named private repository. Repeat final-ref and metadata checks for later source publication.
2. Keep source/image/SBOM/security evidence attached to the reviewed source commit and recheck advisory expiry/current vendor updates before deployment. Current publication covers source; release artifacts and tagged stable releases are outside this preview.
3. For a real deployment, verify its trusted public 443 route, firewall and effective restricted SSH policy. A shared VPS proxy needs a reviewed integration.
4. Rehearse the exact core plus required private overlay and browser/media workflows, then deliberately adopt the recorded core/image version with backup and rollback. The broader private source snapshot and its dependency consolidation remain separate from live production until reviewed for adoption.

The dependency consolidation has passed Node 20/22 tests and dashboard build/typecheck and has landed on its private integration branch; the six superseded dependency PRs are closed. This maintains the separate private application without importing its historical content into public core.

[Release gates](RELEASE-GATES.md), [core/private development](CORE-OVERLAY.md) and [upgrading](UPGRADING.md) describe the durable path from daily improvements to reviewed shared releases.
