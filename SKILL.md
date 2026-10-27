---
name: gymbrobot-agent-workout-vps
description: Save a conversationally approved general workout through the isolated GymBroBot agent CLI.
---

Use only the patched private candidate explicitly selected by the user. Keep credential files private. Run the standalone CLI using Node 22 and the GYMBRO_AGENT_CREDENTIAL path to the owner-scoped 0600 file, through the verified loopback TLS/SSH connection described in README.md. Model subscription access and GymBroBot authorization are separate.

1. Run `node cli.cjs context`. Confirm owner scope, requested workout date and server timezone, total external pounds, equipment, duration, goal, current injuries/symptoms, exclusions and load cap in conversation. Use current constraints to select exclusions and hold/downshift; seek missing safety-critical information. The context contains bounded training history and lacks a clinical feed. Resolve unclear identity before continuing.
2. Send JSON on stdin to `node cli.cjs draft`, using this shape:

```json
{"contextDigest":"FROM_CONTEXT","date":"2026-10-27","goal":"general","durationMin":30,"equipment":["bodyweight"],"exclude":[],"maxLoadLb":0,"progression":"hold","calibrationLoads":{},"units":"lb_total_external","timeZone":"America/Chicago","constraintsConfirmed":true}
```

Goals: general, strength, hypertrophy, muscular_endurance. Equipment: bodyweight, dumbbell. Exclusions must name catalog exercises. Cold-start dumbbell exercises require explicit numeric total-pound calibration loads keyed by exercise name. Confirm timezone from the candidate environment. Use private 0600 files if retaining inputs/outputs. Keep the credential out of chat, argv, logs and environment variables.

3. Present the exact returned draft envelope in conversation, including full `draft` and executable `plan`, ID, version, date, digest, units, context digest, expiry, explanations and load targets. A concise explanation may accompany the canonical JSON. Obtain conversational approval for this exact returned digest/date/version. The user's “yes” authorizes that exact draft when it is unambiguous. A request for revisions requires a fresh draft and approval. Never infer approval from timeout or unrelated assent.
4. Run `node cli.cjs commit` with stdin JSON containing exactly `id`, `digest`, `date`, `version`, `approved:true`, and a fresh stable `idempotencyKey` (16–100 alphanumeric/underscore/hyphen characters). Retain that key across transport retries. Set `approved:true` only after the exact conversational approval. A stale conflict requires refreshed context, a new draft and approval.
5. Run `node cli.cjs readback KEY`. Compare the executable `plan` structurally with the presented draft plan and verify digest/date/version. Report the receipt, approval digest and plan digest. The app shows the same receipt on load or foreground after login. If verification fails, report the concrete failure and preserve the original idempotency key for recovery.
6. Revoke with `node cli.cjs revoke` when access ends. Owner logout/recovery also revokes agent access through generation checks. Re-pairing follows README's stopped-server local procedure.

The API trusts the agent's report of conversational assent. This procedure provides exact payload binding and audit receipts within that trust model. Production writes and broad administrative/SQL tools are outside this workflow.

Require context completeness diagnostics before assessing training. If `requiresHold` is true or metadata is missing, describe fatigue as uncertain, retain progression hold, and show the draft historyAssessment and exercise warnings during approval.

## Agent-authored prescription candidate

To submit your own exact prescription, keep the existing confirmed request fields and add:

```json
{"proposal":{"schemaVersion":1,"exercises":[{"exerciseId":"wall push up","sets":2,"reps":7,"loadLb":0,"rpeCap":6,"restSeconds":60,"reason":"Use fewer repetitions while rebuilding consistency."}]}}
```

Use known catalog exercise IDs. The server rejects unknown/duplicate exercises, unavailable equipment, exclusions, unsafe anchor progression, excessive loads/volume/time and missing cold-start calibration. The server returns the exact normalized plan for conversational approval. A rejection requires a revised draft; preserve explicit approval for the returned digest. Custom sets/reps/loads remain unchanged when accepted. RPE/rest are preserved in plan metadata and coaching text; automatic rest-timer behavior remains a separate UI check.


## Detailed prescriptions and the owner catalog

Read `context.exerciseCatalog` and use exact IDs. The owner can add authored metadata through the authenticated Exercise catalog form. The default metadata seed has 36 exercises; owner additions support further movements. A private overlay can contribute private IDs with unknown equipment. Confirm those explicitly through `equipmentAssignments: {"exercise id":"machine"}` together with the available equipment list.

For a detailed custom plan, send `proposal.schemaVersion: 2`, `name`, `dayType`, `warmup`, `cooldown`, and ordered `exercises`. Each exercise has `exerciseId`, optional safe `slotId`, `block` (`prep`, `strength`, `accessory`, `core`), optional `group`/`variants`, `reason`, and `sets`. Each set includes `type` (`warmup`, `working`, `backoff`, `drop`, `calibration`), `loadLb`, optional `loadMode` (`added`, `assisted`, `pure_bw`), `rpe`, `restSeconds`, optional `notes`, and either `repsLow`/`repsHigh` or `durationSeconds`. Timed exercises can specify `timerSegments` for bilateral holds. All loads mean total external pounds or assistance magnitude as explicitly marked. The server preserves each set instead of collapsing a ramp to one load.

Current hard bounds are 40 exercise slots, 12 sets per slot, 120 sets per session, 26 group labels, 5–240 minutes, and bounded payloads. Constraints, catalog existence, owner-selected load caps, working anchors, calibration caps and fatigue rules still apply. Unknown/private equipment requires conversation confirmation. These bounds describe validation; they do not establish clinical suitability.

Show the full canonical returned plan, set types, distinct loads/reps/durations, groups, notes, uncertainties and exact target date before approval. Commit that stored digest after the user approves. Preserve the original idempotency key after a lost response. The server checks date occupancy and started workouts before saving. Read back the receipt and saved executable plan, then point to its date in the app. No provider credentials belong in the app.
