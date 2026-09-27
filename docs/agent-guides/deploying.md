# Deploying and restarting: production and staging

Two Seam apps run, on two hosts. Run `hostname` before any deploy or restart;
most mistakes here are the right command on the wrong box.

- **Production** (the `[seam]` bot, real guilds): controller on `seam-server`.
- **Staging** (the `[seam-dev]` bot, `seam-dev` guild): controller on
  `seam-dev-server`, checkout `~/seam-staging`.

Dev threads run on the `seam-dev-server` bridge of the **production**
controller. You talk to them through production; you test through staging.

## What runs where

**seam-server** (user `ubuntu`, checkout `~/Projects/seam-acp`)
- `seam-acp`: the production controller.
- `seam-local-bridge` and `seam-sessiond`: production's bridge for this host.
  They run from the same checkout's `dist`.

**seam-dev-server** (user `jessebulpitt`)
- `seam-bridge` and `seam-sessiond`: production's bridge for this host. They
  run from `~/.seam/seam-acp`, which the bridge rollout manages. Never edit or
  build in it.
- `seam-staging`, `seam-staging-bridge` and `seam-staging-sessiond`: the whole
  staging app, running from `~/seam-staging`.
- `~/Projects/seam-acp` plus `wt` trees: where dev work is done. Nothing runs
  from it, so building or "redeploying" it changes no running process.

## Production

From `seam-dev-server`, every production command goes through
`ssh seam-server` (WireGuard, passwordless sudo).

**Deploy merged code, or restart the controller:**
```bash
ssh seam-server 'cd ~/Projects/seam-acp && git pull --ff-only && npm run redeploy'
```
This builds, then drains: new work is held, running turns finish, and systemd
restarts the controller. It can take up to 15 minutes if turns keep running.
Messages sent while it's down are caught up from Discord on startup. Never run
`systemctl restart seam-acp`.

**Pick up bridge or sessiond code on seam-server:** the redeploy rebuilds
their `dist`, but the running processes keep the old code until restarted.
```bash
ssh seam-server 'sudo systemctl restart seam-local-bridge'   # safe: turns stay with sessiond
```
Restarting `seam-sessiond` interrupts running agents; sessiond resumes each
session afterwards. Do it only when sessiond code changed, and say so first.

**Update a remote bridge** (including the dev box's production bridge): run
the rollout on seam-server, because it checks production's bridge registry.
```bash
ssh seam-server 'cd ~/Projects/seam-acp && npm run bridge:rollout -- --target seam-dev-server'
```
That's the read-only preflight. When it's clear, apply with the same command
plus `--rollout --apply`. Its last line prints the exact command. See
[`../bridge-rollout.md`](../bridge-rollout.md) for the separate stage and
activate steps and for rollback. Running bridge turns survive activation.

**Logs and health:**
```bash
ssh seam-server 'sudo journalctl -u seam-acp -n 100 --no-pager'
ssh seam-server 'curl -fsS http://127.0.0.1:3000/health'
sudo journalctl -u seam-bridge -u seam-sessiond -n 100 --no-pager   # dev box's production bridge
```

## Staging

Staging is disposable and shared. One branch is deployed at a time, so post
in the thread before taking it over, and put it back on `main` when done.

**Deploy a branch:**
```bash
cd ~/seam-staging && git fetch && git checkout <branch> && git pull --ff-only && npm run redeploy
```
Same drain-and-restart as production, against staging's own `data/`.
Don't edit code in `~/seam-staging`; push from your `wt` tree, then pull here.

**Restart directly:** allowed on staging, for example after changing `.env`.
```bash
sudo systemctl restart seam-staging                 # controller
sudo systemctl restart seam-staging-bridge          # picks up bridge code
sudo systemctl restart seam-staging-sessiond        # interrupts staging agents; they resume
```
Bridge and sessiond code changes need these restarts. `npm run redeploy`
only restarts the controller.

**Put it back:**
```bash
cd ~/seam-staging && git checkout main && git pull --ff-only && npm run redeploy
```

**Exercise it** with `tester_post`, `tester_read` and `tester_interact`
(staging `#seam-acp` only), and read its logs with
`sudo journalctl -u seam-staging -n 100 --no-pager`.

## The change loop

1. Work in a `wt` tree on `seam-dev-server`, then push the branch.
2. Deploy the branch to staging and run the real path there: a real turn, a
   restart, clicks or slash commands through `tester_interact`.
3. Merge.
4. Put staging back on `main`.
5. Deploy production with `ssh seam-server ... npm run redeploy`, plus a
   bridge rollout or sessiond restart if that code changed.
6. Check production logs for the behaviour you changed.
