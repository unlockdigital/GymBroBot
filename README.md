# GymBroBot

GymBroBot is a self-hosted training web app for one owner. Keep your workout history on your server, build and log detailed strength and cardio sessions, and use your results to plan the next workout. Run it at your own domain or subdomain on a Linux VPS and open it from your computer or phone.

A local rule-based planner works without a model-provider key. You can also connect your coding agent, ask it to review your training and design a workout, approve the proposed draft in conversation, and have it save that exact plan into the app. Provider sign-in and subscription access stay with your agent client.

This repository is a release candidate. Read [release status](docs/RELEASE-STATUS.md) before using it for important training records or public hosting.

## Training features

- Owner-managed exercise catalog with 36 initial metadata entries and further owner additions.
- Ordered preparation, strength, accessory and core blocks, rotating variants, supersets and circuits.
- Individual warmup, working, backoff, drop and calibration sets with distinct load, rep range or duration, RPE target, rest and notes.
- Explicit added-weight, assisted and bodyweight modes, with conservative calibration when changing modes.
- Persistent workout history, strength/cardio logging, edits, recovery and retry-safe saves.
- Optional offline access on a consented device, durable queues and recovery safeguards.

The built-in planner provides transparent rules for its supported templates. External agents can propose the richer workout format through the same application validation and save boundary. Current equipment, constraints and calibration decisions need owner confirmation. Missing or inconsistent history stays visible and can hold progression.

## Install at your domain

The supported build target is Linux amd64 with Docker Engine and Compose v2. The application and patched proxy are built from pinned sources; the build requires Internet access to the referenced registries and repositories. Linux arm64 remains a separate verification target.

Choose an unused hostname, set its A record to your VPS address, and allow public TCP 80/443. Add AAAA only after verifying IPv6 routing and firewall behavior. Keep the agent endpoint private. Follow [hosting and recovery](docs/HOSTING.md) for the complete setup and backup procedure.

```sh
umask 077
cp .env.example .env
# Set PUBLIC_HOST and OWNER_TIMEZONE in .env.
python3 scripts/prepare-hosting.py
docker compose build init caddy
docker compose run --rm init
docker compose run --rm app setup
docker compose up -d app caddy agent-proxy
```

Open the trusted HTTPS URL and claim the instance with the temporary setup capability. Store your recovery capability securely. Confirm your timezone and the load-unit convention before logging or designing workouts.

On Safari, a bookmark gives quick browser access. Share → Add to Home Screen adds a launcher; the exact options depend on the browser/device version. Headless Chromium and WebKit verification is described in the release status. Native Safari/iOS installation has its own acceptance scope.

## Connect your agent

Use [agent setup](docs/AGENTS.md), then give your local agent the repository's [workout skill](SKILL.md). The normal interaction is:

1. Read bounded training context and confirm the date, equipment and current constraints.
2. Design and revise the workout in conversation.
3. Show the validated, canonical draft and ask for approval.
4. Save the approved draft and verify its receipt and plan through application readback.

The connection uses a separate, revocable application credential through a restricted SSH tunnel. Direct commit records the agent's assertion of conversational approval. Authorized training context enters the chosen agent provider's processing environment. GymBroBot never needs that provider's account credentials.

## Develop and release

Run `python3 scripts/check-tree.py` and `sh scripts/test-linux.sh` in a supported Docker environment. CI uses synthetic data. Real records, credentials, private overlays and operational evidence belong outside this repository.

[Core and private deployment](docs/CORE-OVERLAY.md) explains how a general fix discovered in daily use becomes a reviewed core change and a tested deployment update. The existing private application remains on its current deployment while that transition is prepared.

See [privacy](PRIVACY.md), [security](SECURITY.md), [rights](docs/RIGHTS.md), [release gates](docs/RELEASE-GATES.md) and [the roadmap](docs/ROADMAP.md) and [project history](docs/PROJECT-HISTORY.md). The repository carries its existing ISC license; third-party components retain their notices. Exercise GIFs, personal health records and private integration data are excluded from the public source selection.
