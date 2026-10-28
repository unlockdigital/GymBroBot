# Security build baseline

The release profile is Linux amd64 using the checked Compose topology: the app serves through Unix sockets with no network, a nonroot UID, zero effective capabilities, no-new-privileges, read-only root filesystem and scoped private mounts. Public HTTPS and private agent TLS terminate in separate proxy containers. Fixed-path root volume initialization is operator-only. Additional executable private hooks require separate review.

## Built components

| Component | Selected baseline |
|---|---|
| Application runtime | Official Node 22.23.4 on Debian 13/trixie slim; active security repositories |
| Node SQLite | better-sqlite3 13.0.3 compiled from checksum-pinned npm source, SQLite 3.53.4 |
| Python operations SQLite | SQLite 3.53.4 compiled from the same amalgamation and loaded through `/opt/sqlite/lib` |
| HTTPS proxy | Modified Caddy 2.11.7 built with Go 1.26.10, x/net 0.60.0 and chi 5.4.0 |

The Docker build asserts the active Node and Python SQLite versions. Preserve the image's `LD_LIBRARY_PATH` for maintenance operations. Upstream native addon prebuilds and runtime package managers are removed. The reviewed surface patch also removes unused mount, umount, nsenter and infocmp commands, while retaining package records for honest scanning.

The proxy builds from a checksum-pinned source graph into a static scratch image. It embeds public root certificates, timezone data, the modification notice and compiled-module license notices. Rebuild it when the compiler, root store or relevant modules receive security updates.

Sample environment, Dockerfile and Compose defaults must select this same baseline. `scripts/check-security-baseline.py` rejects unsafe sample overrides. Build both `init` and `caddy`; the proxy uses `pull_policy: never` to select the local reviewed build. A future registry distribution needs verified platform digests before changing that policy.

## Advisory decision

The named thirteen high advisory IDs have individual bounded applicability dispositions in [the advisory decisions](ADVISORY-DECISIONS.md) and [machine-readable record](ADVISORY-DECISIONS.json). They concern removed/missing command implementations or Python/library paths absent from the supported execution flow. Retained affected packages remain visible in the raw scan. The decision establishes applicability within the checked execution profile; upstream package remediation remains tracked separately.

The review expires November 11, 2026. New images/packages, imports, extensions, subprocess paths, privilege/network changes, vendor guidance or stable fixes trigger earlier review. Keep the runtime surface regression in CI. An arbitrary privileged host invocation or executable overlay is outside the approved public-core profile.

The reviewed proxy image has zero rated vulnerability findings and an UNKNOWN module advisory whose affected OpenPGP package is absent from the compiled package list. Keep that finding and its evidence visible. The npm lock has five dependencies with official tarball URLs and SHA512 pins; its audit reports zero advisory hits for that graph. Neither statement covers the application OS or unknown defects.

## Release evidence

Record exact source, architecture, final image/config digests, resolved package inventory, native-component hashes, SBOMs, scanner/database timestamps, tests and advisory dispositions for each release. Apt inputs resolve from active security repositories and may change between builds. An earlier image's exception cannot silently approve a new image.

The final Linux amd64 application image is `sha256:7c3e93524b7a5e21c1aec7d640818ef0d93410aa9bac068f14c5aa01ad99992b`; the proxy image is `sha256:9ee978d97b08832cb848fab859a4ca97d43cc2b6f5b51488db932f226129aff7`. These are local image identities from the rehearsal. Registry installation requires a separately published and verified distribution digest.

The combined runtime passed 24 named Linux checks, the 24-case assisted-edit regression, actual Compose initialization/pairing/backup/empty-volume restore/generation rotation, and a native-image Chromium smoke. Exact-source Chromium/WebKit acceptance passed ten suites and 110 assertion groups. The release verifier passed sixteen controls under ordinary and optimized Python, including fourteen expected rejections.

[Release evidence](RELEASE-EVIDENCE.json) records these identities and scope. [Image inputs](IMAGE-INPUTS.json) preserves all 78 tested build inputs across subsequent documentation and test-only additions. Build from a clean source checkout; generated files inside an allowed Docker context can change the build. See [release status](RELEASE-STATUS.md) and [release gates](RELEASE-GATES.md) for the remaining boundaries. Linux arm64, complete native-device behavior and intended-host public reachability remain separate support claims.
