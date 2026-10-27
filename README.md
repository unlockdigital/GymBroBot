# GymBroBot

GymBroBot is a self-hosted single-owner training web app. Keep your workout history on your server, log strength and cardio sessions, and create a basic workout with the local rule-based planner. A separately authorized local coding agent can read bounded training context, propose a workout in conversation, save the approved draft, and verify the saved plan.

This source candidate is undergoing release review. The owner catalog supports 36 initial metadata entries and further owner additions; detailed agent proposals preserve per-set prescriptions. The current package pins Node 22.23.4 and Caddy 2.11.7 with Linux Docker with persistent SQLite storage. Model-provider authentication stays with your agent client; the app requires zero model-provider keys.

## Host it at your domain

Use a Linux VPS with Docker Engine and Compose v2. Run the documented hosting preparation step to normalize the two public proxy-template modes while preserving credential privacy. Point your domain or subdomain at its public IP, configure public TCP 80/443, and restrict SSH to your administrative policy. Follow [hosting and recovery](docs/HOSTING.md). Users can reach the trusted HTTPS URL from any Internet-connected browser. Your browser device must be able to reach the server for online synchronization.

On Safari, save a bookmark for browser access or use Share → Add to Home Screen for a launcher. Safari may offer Open as Web App. Native Safari/iOS installation remains unverified. Chromium and isolated WebKit tests cover preceding candidate flows with real loopback-server outages; release verification must target the exact release revision.

## Work with your coding agent

[Agent instructions](SKILL.md) describe context → draft → conversational approval → commit → readback. The agent connection uses a separate application credential and a restricted SSH tunnel to the private agent endpoint. The provider running your agent receives the context shared in that conversation. Direct commit trusts the agent's report of your approval. Current pairing requires a maintenance command and expires after 24 hours.

## Development and release

Run `python3 scripts/check-tree.py` and `sh scripts/test-linux.sh` in the supported Docker environment. [Release gates](docs/RELEASE-GATES.md) describe pending evidence. [Core and private deployment](docs/CORE-OVERLAY.md) defines the improvement and promotion path. Public publication stays gated until privacy, rights, dependencies and the exact source revision pass review.

The ISC license permits use, modification, distribution and commercial use under its terms. [Rights inventory](docs/RIGHTS.md) records redistribution review status. Exercise GIFs and the existing private exercise corpus are excluded from this candidate.


## Detailed workout and catalog candidate

The workout interface supports owner-authored exercise metadata and schema-v2 agent proposals with per-set loads, rep ranges, effort targets, rest, timed sets, preparation/core/accessory blocks, rotating variants and circuit groups. Manage authored metadata in the authenticated Exercise catalog section. The bundled seed contains 36 authored labels/equipment tags and carries no descriptions or exercise media. The rule-based planner can select matching catalog movements for its supported squat/push/pull templates. External agents can propose the wider supported format through the same validated approval and readback contract.

Existing private `workout_plans` rows are read through extracted generic mapper functions in a coherent owner-scoped snapshot. Explicit private hooks can preserve the existing preparation helpers and private catalog metadata. Set `privatePlanHooks` to an absolute owned-0600 `.cjs` path and `privatePlanHooksSha256` to its reviewed SHA256 in private-copy config. Keep this source and its private metadata outside the public repository. Unknown equipment remains unknown until confirmed; media remains a separate private provider. Core files contain no private hook dataset.

This slice has synthetic service/SQLite/browser evidence. Exact Linux deployment and real private-copy rehearsal are separate acceptance gates. Existing private production remains the stable baseline until those checks pass.
