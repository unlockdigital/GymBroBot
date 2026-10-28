# Browser acceptance

On October 28, 2026, source `b81df078802b7d2188f00ccec5bb9b35ff1309a6` passed ten isolated Chromium/WebKit suites with 110 assertion groups. The shipped assisted-edit regression passed all 24 cases. Any later release must confirm that the tested runtime inputs remain identical or rerun the affected flows.

| Flow | Chromium | WebKit |
|---|---|---|
| Assisted corrections and rep-mode transitions, synced and queued | PASS | PASS |
| Rich per-set and timed transitions | PASS | PASS |
| Assisted history and model-free/agent planning | PASS | PASS |
| Offline shell, queue, reconnect and lost-response durability | PASS | PASS |
| Storage failure, identity/recovery/logout and worker update safety | PASS | PASS |

The tests use actual UI/HTTP/CLI/SQLite modules with synthetic accounts and rows, isolated headless browser profiles, temporary loopback TLS/Unix-socket adapters and fault injection. Native macOS dependencies were better-sqlite3 13.0.3/SQLite 3.53.4 with Node 22.22.2, Playwright 1.62.1, Chromium 156.0.8078.4 and WebKit 26.5. There were zero unexpected page errors and external page requests. One expected WebKit identity transport error occurred during deliberate server failure. Disposable state was removed.

Corrections preserve NULL external weight for bodyweight/assisted sets, retain help amounts, switch zero assistance to bodyweight, and preserve positive added load on rep/timed bodyweight edits. New values survive offline reload and converge exactly once on reconnect.

Listener shutdown models server unavailability while the browser remains nominally online. Physical Safari/iOS/Android installation, airplane mode, background suspension, eviction, hardware loss, haptics and audible alerts remain separate platform support claims. No manual phone-installation gate is asserted for this automated candidate. Private media and a real model-provider conversation are outside these synthetic browser results.

[Machine-readable summary](BROWSER-ACCEPTANCE.json) records asset hashes and scope. Native Linux/Compose and advisory decisions have separate evidence.
