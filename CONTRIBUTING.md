# Contributing

Use a clean checkout of the public core. Describe the user-visible problem, the proposed behavior and the validation needed. Keep changes small enough to review. Use synthetic owners, workouts and credentials in examples and tests.

General application fixes, migrations, CLI/agent contracts and reusable tests belong in core. Personal configuration, health records, account tokens, production databases, private prompts, proprietary integrations and operational reports belong in private deployment storage. Exercise metadata and media need a recorded redistribution basis before inclusion.

Run `python3 scripts/check-tree.py` and the relevant tests; use `sh scripts/test-linux.sh` for supported native Linux changes. New workout behavior must preserve owner scope, exact approval/readback, set-mode semantics, conflict handling and retry safety. Migrations and recovery changes require a disposable backup/restore rehearsal.

For a PR, explain what changes for the user, why it is needed, which checks passed and any limits. Keep secret or private-data findings in the configured private security-reporting channel. The maintainer must configure that channel before public release.

Contributors must have the rights to submit their changes under the repository license and preserve required third-party notices. Describe the source and license of copied or generated assets. The project does not require a contributor to disclose personal training data to reproduce a problem.
