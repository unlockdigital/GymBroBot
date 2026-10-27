# Privacy

Your server stores workout and owner authentication data in SQLite. Browser offline access stores private workout state on the device after consent. Backups and recovery exports are plaintext and require private handling and encrypted storage where appropriate.

The default telemetry adapter is a no-op. The app uses local application requests. A coding agent receives bounded training context when you authorize access; its provider processes context placed in conversation under that provider's terms and settings. Current constraints require conversation input. Device/agent credentials expire and can be revoked; recovery/logout changes lifecycle generation.

The default public candidate excludes the private wearable/lab integrations and exercise media. Review actual outbound behavior and retention against the exact release build before deployment.
