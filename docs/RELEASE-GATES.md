# Release gates

Publication remains blocked until each gate has evidence for the exact commit and built image.

- Full tree and every reachable Git ref pass a maintained secret scanner and private-identifier denylist. Pattern scanning alone provides bounded assurance.
- Independent privacy review confirms data flows, default training context, recovery export, logs, browser storage and credentials.
- Provenance and redistribution inventory covers every source and asset, including icons and dependency notices.
- Fresh supported Linux amd64/arm64 dependency builds pass current advisory and OS-image review; the historical pinned Debian snapshot requires update assessment.
- Exact package passes owner enrollment/recovery, persistent workout flow, model-free planner, agent digest/approval/readback, revocation, concurrent writes and backup/restore.
- Actual isolated private-copy rehearsal preserves all prior application data and schema. Evidence for predecessor versions is recorded separately.
- Domain/HTTPS/firewall/restricted SSH policy pass on the intended deployment without touching the live service.
- Browser offline/retry/update/storage-failure tests target the exact package. Safari/iOS claims match tested scope.
- Public documentation, support scope, privacy policy, security reporting and clean source history are reviewed.

CI is an initial safety net. It does not establish all these gates. Preserve the existing private repository; public visibility changes happen only after these gates pass.
