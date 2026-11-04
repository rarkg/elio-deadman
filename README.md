# Dead-man switch

Runs every 5 minutes on GitHub Actions. Reads a heartbeat document that a machine rewrites every minute, and
alerts on Discord when it stops for 15 minutes or when the machine reports itself down for that long; says so
again when it is back.

Secrets: `PULSE_URL` (the heartbeat document's read URL), `DISCORD_WEBHOOK` (a channel webhook). Without the
webhook a stale heartbeat fails the run, and GitHub emails the account owner.
