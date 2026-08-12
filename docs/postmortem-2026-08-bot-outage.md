# Post-Mortem: Bot Outage Jul 25 - Aug 12, 2026

*Written by Claude (Anthropic) on 2026-08-12, during the incident response session. Findings were gathered from the live droplet: container logs, cgroup PID counters, process tables, and the healthcheck cron log. The zombie leak rate and the fix were both verified by direct experiment on the running container.*

## Summary

The sfedits bot stopped posting to both Bluesky and Mastodon on Jul 25, 2026. The outage went unnoticed for 17 days until manual investigation on Aug 12. The root cause was a process leak: Chromium helper processes were never reaped, filling the container's PID table until `fork()` failed and screenshots became impossible.

Alerting existed and would have caught this on Jul 27, two days in. It never ran. `scripts/healthcheck.sh` had been non-executable on the droplet since Mar 9 and cron had been failing with `Permission denied` every 30 minutes for five months.

This outage is a direct sequel to the Feb 2026 one. Action item #2 from that post-mortem ("add uptime monitoring/alerting so outages are detected within hours, not months") was implemented on Mar 8 and silently disarmed itself on Mar 9.

## Timeline (all times UTC)

- **2026-03-08** - Healthcheck and DM alerting added (commits `6675634`, `290a455`, `da22efe`), addressing action item #2 from the Feb post-mortem. Verified working: the log shows real `OK` runs, and one genuine `ALERT` fired on Mar 8 16:00
- **2026-03-09 03:00** - Last successful cron run of the healthcheck
- **2026-03-09 03:28** - A deploy runs `git reset --hard origin/main`. Because `scripts/healthcheck.sh` is tracked in git as mode `644`, the reset strips its execute bit. Every cron run from here on prints `Permission denied`. No alerting exists from this moment, and nothing reports that fact
- **2026-06-06 21:06** - Bot container created (commit `96f2d11`). PID 1 is `node page-watch.js`
- **2026-06-06 to 07-25** - Each Puppeteer launch orphans two `chrome_crashpad_handler` processes to PID 1. Node never reaps them. At roughly 5 posts/day the container accumulates ~10 permanent zombies per day
- **2026-07-25 09:10** - Last successful post. `data/heartbeat-post` freezes at this timestamp
- **2026-07-25 17:55** - First failure, in degraded form: Chromium launches but dies mid-handshake (`ECONNRESET`, socket hang up) as the PID table nears its ceiling
- **2026-07-27** - The post-heartbeat check would have alerted here (threshold: no successful post in 2 days). It did not run
- **2026-07-30 06:04** - Hard failure begins. `fork()` returns `EAGAIN` and every launch fails immediately with `Cannot fork`
- **2026-07-30 to 08-12** - Every detected edit is dropped at the screenshot step. IRC stays healthy throughout, so the bot sees each edit and silently discards it
- **2026-08-12** - Outage discovered manually. Container restarted, root causes identified and fixed (commit `dc38045`)

## Root Cause

**Immediate cause: PID exhaustion.** `page-watch.js` runs as PID 1 in the bot container. Unlike a real init process, Node never calls `wait()` on re-parented children. Every Puppeteer launch left two `chrome_crashpad_handler` processes as permanent zombies.

At 485 zombies the container hit its ceiling:

```
pids.max     = 498
pids.current = 496
```

`fork()` then returned `EAGAIN`:

```
/usr/bin/chromium: 5: /etc/chromium.d/extensions: Cannot fork
FATAL: posix_spawn .../chrome_crashpad_handler: Resource temporarily unavailable (11)
```

`takeScreenshot()` returned null, and per the project rule that every post must include a screenshot, each post was correctly rejected. The bot was functioning exactly as designed on top of a broken host environment.

Confirmed experimentally: launching Chromium once took the zombie count from 0 to 2. The arithmetic corroborates the timeline: 485 zombies / 2 per launch = ~242 posts, and the container ran 49 days at roughly 5 posts/day. The ceiling was always going to be reached at ~245 posts, about seven weeks after any container creation.

**Memory was not involved.** A natural first guess on a 454MB droplet, but the bot was using 22MB of its 256MB limit at the moment of failure. Chasing memory would have wasted the investigation.

**The protection existed and was lost in a migration.** The Mar 8 recovery in the previous post-mortem started the bot with `docker run -d --init ...`, which reaps orphans correctly. When the project moved to docker-compose, `init` was not carried across to `docker-compose.yml`. Nothing failed at migration time, because the leak only becomes visible after roughly 245 posts. A protective flag dropped during a rewrite produces no symptom until the budget it was silently protecting runs out.

**Why it went unnoticed: the monitor was dead and could not say so.** Git tracks file modes. `scripts/healthcheck.sh` was committed as `644` while the local working copy was `-rwxr-xr-x`, so it ran fine when tested by hand and was dead on the server. Deploys enforce the git mode via `git reset --hard`, so the deploy actively disarmed it.

The healthcheck's three checks were all correct, and the post-heartbeat threshold would have fired on Jul 27. The alert delivery path was also fully intact: Bluesky credentials valid, DM conversation present, Mastodon token valid. Every component worked except the one that invokes them.

## Resolution

Commit `dc38045`:

- `init: true` on the `bot` and `admin` services, running tini as PID 1 so orphaned helpers are reaped. Applied to `admin` as well, since it posts drafts through the same `takeScreenshot` path and had the same latent leak
- `scripts/healthcheck.sh` mode `644` to `755`

Verified after deploy:

```
PID 1 in bot/admin    = /sbin/docker-init
zombies after a screenshot = 0   (was 2 per launch)
pids.current          = 12 / 498  (was 496 / 498)
healthcheck.sh        = -rwxr-xr-x
cron run 16:00:02     = OK        (first success since Mar 9)
```

## Incident During Recovery

The deploy itself took the bot and admin down for several minutes. `docker-compose up -d` against existing containers crashed:

```
File ".../compose/service.py", line 1579, in get_container_data_volumes
    container.image_config['ContainerConfig'].get('Volumes') or {}
KeyError: 'ContainerConfig'
```

The droplet runs docker-compose 1.29.2 against Docker 29.x. Newer image inspect output no longer includes `ContainerConfig`, which compose v1 reads when preserving volumes across a recreate. Compose stops the old containers *before* hitting this, so the failure leaves services down, renamed `<hash>_sfedits_bot_1` at Exit 137.

Recovered with `docker rm -f` on the stale containers followed by `docker-compose up -d`. Safe here because every volume is a bind mount, so no data was at risk.

Only the recreate path is affected. `deploy.sh` does `down` then `up -d`, which creates containers fresh and does not hit this. The lighter-looking targeted command was the riskier one.

## Action Items

1. **Add a dead man's switch.** This is the important one. The healthcheck runs from cron on the same droplet it monitors and cannot report its own failure. Silence from a dead monitor is indistinguishable from silence meaning "all healthy". The droplet should ping an external service on each OK, and that service should alert when pings stop
2. **Verify the alert path end to end after any change to it.** All four credential checks passed here, but they were only checked five months after the fact. A periodic synthetic alert would confirm delivery still works
3. **Audit executable bits in git.** `deploy.sh` and `scripts/docker-cleanup.sh` are still tracked as `644`. They work today only because the working copies happen to be `+x`; a fresh clone breaks them exactly as `healthcheck.sh` broke
4. **Consider upgrading off docker-compose v1.** It is EOL and now actively broken against Docker 29 on the recreate path. Until then, always deploy via `deploy.sh` (`down` then `up`), never a bare `up -d`
5. **Prefer structural fixes over limit increases.** Raising `pids.max` would have delayed this failure by weeks and taught nothing. The leak was the bug
6. **Diff the effective runtime config when changing deployment mechanism.** `--init` survived the Mar 8 recovery and was dropped in the move to docker-compose. Compare the actual flags in force before and after any such migration, since the failures this class of omission causes are delayed by weeks and look unrelated
