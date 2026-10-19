# Notes for agents working on the SF Edits bot

This repo is the Wikipedia-edits bot behind SF Edits (it runs in Docker on a
DigitalOcean droplet). It is not the sfdailybrief.com pages, which live in
[mrfinnsmith/sf-daily-brief](https://github.com/mrfinnsmith/sf-daily-brief).
The shared principles all agents follow are in agent-ops
`reference/agent-principles.md`.

## Rules from Finn (2026-10-19)

- Talk with Finn before any change to the bot, including edits to the
  watchlist. Show him the evidence first (for example, the exact pages).
- Track bot work in GitHub issues on this repo, never in Linear.
- Each bot bug gets its own fresh thread in the Buzz #sf-daily-brief channel.
- Bad data the bot runs on (such as `watchlist.json`) is a code bug: fix it
  with a check that guards it, not only a hand edit to the data.
- The bot reads the watchlist only at startup, so a merged watchlist change
  does nothing until the bot is redeployed (`deploy.sh`).
