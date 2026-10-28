# Release gates

The public release is an explicit selection of source refs and built images. Record evidence for the selected source/image pair; earlier compatible results must name which bytes are unchanged.

| Gate | Required evidence |
|---|---|
| Source/privacy boundary | Whole clean reachable history and final tree scanned; reviewed allowlist, private identifiers/data absent, metadata and synthetic fixtures checked |
| Rights | Source/asset lineage, ownership confirmation, dependency and patched-proxy notices, exact SBOM/component inventory |
| Security decision | Each high/critical finding fixed or justified with component/code-path/topology evidence, exact digests, review expiry and invalidation triggers; medium/low findings retained for maintenance |
| Supported build | Fresh Linux amd64 source/native builds, active Node/Python SQLite versions, nonroot entrypoint/proxy setup and integrity-complete dependency lock; additional platforms claimed only after testing |
| Workout/application | Enrollment/login/recovery, rich catalog/per-set modes, assisted progression, logging/edit/completion/history, owner isolation and exact agent approval/commit/readback |
| Recovery | Quiescent backup to new private storage, empty-volume restore, credential rotation and private-extension/certificate backup coverage |
| Everyday browser use | Current-source rich and assisted flows plus offline/retry/storage-failure/update/logout checks in supported isolated browsers; native Safari/device limits stated |
| Private compatibility | Reviewed core plus separate owner-scoped overlay on disposable real storage, preserved original rows/schema and representative plan projection; private media and complete deployed surfaces named separately |
| Hosting | Intended-host DNS/CA/port reachability, provider/host/Docker firewall behavior, loopback agent endpoint and effective restricted SSH policy |
| Public repository | Fresh selected history and refs, GitHub-hosted metadata/private archive boundary, public-safe CI, exact repository identity and visibility decision |
| Documentation/support | Reproducible quickstart, agent pairing, privacy, advisory decisions, backup/recovery, supported versions, private security-reporting destination and known limitations |

CI is one source of evidence. It does not attest to a deployment's DNS/firewall, arbitrary private hooks, owner rights or every device/browser. Record test failures and untested flows rather than filling them with predecessor evidence.

See [release status](RELEASE-STATUS.md) for the reviewed baseline and [core/private deployment](CORE-OVERLAY.md) for the update path. Existing production remains on its current deployment until a separate reviewed promotion is deliberately performed.
