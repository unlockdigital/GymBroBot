# GymBroBot

GymBroBot is a self-hosted single-owner training web app. Keep your workout history on your server, log strength and cardio sessions, and create a basic workout with the local rule-based planner. A separately authorized local coding agent can read bounded training context, propose a workout in conversation, save the approved draft, and verify the saved plan.

This source candidate is undergoing release review. The included planner supports six exercise choices. The current package uses Node 22 and Linux Docker with persistent SQLite storage. Model-provider authentication stays with your agent client; the app requires zero model-provider keys.

## Host it at your domain

Use a Linux VPS with Docker Engine and Compose v2. Point your domain or subdomain at its public IP, configure public TCP 80/443, and restrict SSH to your administrative policy. Follow [hosting and recovery](docs/HOSTING.md). Users can reach the trusted HTTPS URL from any Internet-connected browser. Your browser device must be able to reach the server for online synchronization.

On Safari, save a bookmark for browser access or use Share → Add to Home Screen for a launcher. Safari may offer Open as Web App. Native Safari/iOS installation remains unverified. Chromium and isolated WebKit tests cover preceding candidate flows with real loopback-server outages; release verification must target the exact release revision.

## Work with your coding agent

[Agent instructions](SKILL.md) describe context → draft → conversational approval → commit → readback. The agent connection uses a separate application credential and a restricted SSH tunnel to the private agent endpoint. The provider running your agent receives the context shared in that conversation. Direct commit trusts the agent's report of your approval. Current pairing requires a maintenance command and expires after 24 hours.

## Development and release

Run `python3 scripts/check-tree.py` and `sh scripts/test-linux.sh` in the supported Docker environment. [Release gates](docs/RELEASE-GATES.md) describe pending evidence. [Core and private deployment](docs/CORE-OVERLAY.md) defines the improvement and promotion path. Public publication stays gated until privacy, rights, dependencies and the exact source revision pass review.

The ISC license permits use, modification, distribution and commercial use under its terms. [Rights inventory](docs/RIGHTS.md) records redistribution review status. Exercise GIFs and the existing private exercise corpus are excluded from this candidate.
