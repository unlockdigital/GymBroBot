# Roadmap

## Release candidate

The bounded thirteen-advisory decision, combined Linux/Compose rehearsal and current-source Chromium/WebKit acceptance are complete. Private dependency consolidation has landed on its integration branch and the six superseded PRs are closed. Private main and production retain their existing versions while broader source adoption is reviewed.

The shared source uses `unlockdigital/GymBroBot`; the historic repository retains its private history under its distinct name. Maintain the audited source and private vulnerability-reporting channel. Source is the preview distribution. Verify effective intended-host firewall/SSH policy and rehearse the required private overlay before adopting the shared core in daily production. The bounded public HTTPS marker test on the existing 443 route has passed.

## Daily development and shared releases

Keep general app code, migrations, CLI, synthetic tests and documentation in core. Keep deployment settings, credentials, personal training preferences and private integrations in a private overlay. Prove the reviewed core plus overlay on disposable storage before adopting a new version. Record the core commit and image so a deployment can be reproduced or rolled back.

Turn each general issue found in daily use into a synthetic core regression. Implement and review the core change, build/test it, rehearse private compatibility, then update the private deployment version and issue the public release. This transition is being prepared; the current live deployment has not switched to this model.

## Following releases

Prioritize robust imports and improved offline workout recovery. Refine the model-free planner, exercise metadata and training-policy preferences using explicit progression evidence. Add daily mobility after its logging and training-context integration are designed.

Later optional integrations may include running services, wearables, heart rate, blood pressure and laboratory inputs with explicit owner-controlled disclosure and validation. Advanced health analytics and health-data question answering follow the training foundation. Telegram can be evaluated as a separate notification/capture connector after the standalone loop proves useful. CRM functionality stays outside this product.
