# Dead-man switch

Runs every 5 minutes on GitHub Actions. Reads a heartbeat document that a machine rewrites every minute, and
alerts on Discord when it stops for 15 minutes or when the machine reports itself down for that long; says so
again when it is back.

Secrets: `PULSE_URL` (the heartbeat document's read URL), `DISCORD_WEBHOOK` (a channel webhook). Without the
webhook a stale heartbeat fails the run, and GitHub emails the account owner.

It also reads the guard auditor's part of the heartbeat (last run, the longest gap between its runs in the last
24 hours, the seal value) and logs it every run, so this log keeps an off-Mac history of the seal. A stopped
auditor alarms once; a gap the machine declared as a drill is logged as `[drill] auditor gap` and excused at most
once a week.
