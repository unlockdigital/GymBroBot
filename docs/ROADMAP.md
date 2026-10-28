# Roadmap

## Release candidate

Finish the per-advisory security decision and supported image baseline. Complete current-source Chromium/WebKit acceptance for enrollment, rich and assisted workouts, queue recovery, updates and logout. Verify the private dependency consolidation and close superseded PRs only after their changes are represented in landed code.

Publish reviewed setup, privacy, security, backup/recovery, agent and contributor guidance. Establish an empty private staging repository for the clean public source, audit its reachable objects and GitHub-hosted metadata, and publish only the explicitly approved refs when distribution gates pass.

## Daily development and shared releases

Keep general app code, migrations, CLI, synthetic tests and documentation in core. Keep deployment settings, credentials, personal training preferences and private integrations in a private overlay. Prove the reviewed core plus overlay on disposable storage before adopting a new version. Record the core commit and image so a deployment can be reproduced or rolled back.

Turn each general issue found in daily use into a synthetic core regression. Implement and review the core change, build/test it, rehearse private compatibility, then update the private deployment version and issue the public release. This transition is being prepared; the current live deployment has not switched to this model.

## Following releases

Prioritize robust imports and improved offline workout recovery. Refine the model-free planner, exercise metadata and training-policy preferences using explicit progression evidence. Add daily mobility after its logging and training-context integration are designed.

Later optional integrations may include running services, wearables, heart rate, blood pressure and laboratory inputs with explicit owner-controlled disclosure and validation. Advanced health analytics and health-data question answering follow the training foundation. Telegram can be evaluated as a separate notification/capture connector after the standalone loop proves useful. CRM functionality stays outside this product.
