# Reviewed build baseline

The source pins Node 22.23.4 and Caddy 2.11.7 using immutable image digests. Docker builds native SQLite from the npm lockfile and uses active Debian bookworm/security repositories. Record resolved Debian packages and built image digest per release because apt inputs can change over time.

Independent synthetic Linux arm64 review completed a fresh patched build, seven regression suites and actual Caddy TLS CLI/context/draft/commit/readback plus backup/restore checks. Locked npm graph review returned zero npm advisory hits for 40 packages. These findings apply to that review's build and scope. The exact clean repository still needs its own fresh CI result.

The Node baseline follows the [October 21, 2026 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) and [22.23.4 release notes](https://nodejs.org/en/blog/release/v22.23.4). Caddy uses [2.11.7](https://github.com/caddyserver/caddy/releases/tag/v2.11.7). better-sqlite3 remains 12.8.0 for compatibility; newer native versions need explicit compatibility/advisory review.

Open gates include exact Linux amd64 execution, private-copy compatibility for this revision, SBOM/dependency notices, OS vulnerability scanning, final browser coverage and public DNS/TLS/firewall checks. This document provides bounded build evidence and carries no full-system vulnerability-free claim.

The npm lockfile retains all 39 selected package versions and includes official registry tarball URLs and SHA512 integrity pins. Fresh npm ci package retrieval/hash verification and macOS Node22 native compile/agent-history checks passed. The corresponding fresh Linux build was interrupted by Docker snapshotter I/O errors, so its final native Linux evidence remains open. Previous Linux build evidence used identical versions with the earlier hashless lockfile. CI rejects missing official registry SHA512 pins and invokes npm ci inside the native build.
