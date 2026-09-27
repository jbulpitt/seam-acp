# Deploying and restarting

How Seam's processes are deployed and restarted. Your deployment's hosts,
checkouts and exact commands live in its operator context (`docs/local/`,
if present). Read that before running anything; most mistakes here are the
right command on the wrong host.

## The processes

- **Controller** (`seam-acp.service`): Discord, orchestration, persistence.
  Runs from one checkout's `dist`.
- **Bridge:** one per host. The controller host runs a local bridge; other
  hosts dial in over WebSocket.
- **sessiond:** one per bridge host. It owns the agent processes and keeps
  them alive through controller and bridge restarts.

## Controller

```bash
npm run redeploy
```

Run it in the checkout the controller runs from. It builds, then writes a
restart sentinel. The running controller stops taking new work, lets
running turns finish, and exits; systemd restarts it. Messages sent while it's
down are caught up from Discord on startup.

In any other checkout, `npm run redeploy` writes a sentinel that no controller
reads, so nothing restarts. Never restart the controller directly with
`systemctl restart` or `pm2 restart`: that kills running turns, including the
one that ran the command.

## Bridges and sessiond

`npm run redeploy` rebuilds the local bridge's and sessiond's `dist`, but the
running processes keep the old code until they restart.

- **Local bridge:** `systemctl restart` it. That's safe, because running turns
  stay with sessiond.
- **sessiond:** a restart interrupts running agents, and sessiond resumes each
  session afterwards. Do it only when sessiond code changed.
- **Remote bridges:** `npm run bridge:rollout -- --target <host>` is a
  read-only preflight; add `--rollout --apply` to apply. It runs on the
  controller host, because it checks the controller's bridge registry. See
  [`../bridge-rollout.md`](../bridge-rollout.md).

## Staging

A second, independent deployment with its own bot, guild, checkout, `data/`
and units. You deploy a branch there, test it for real, and only then merge.
It's shared, so say so before taking it over, and put it back on `main` when
done. Restarting staging's units directly is fine.
[`test-deployment.md`](test-deployment.md) covers setup and the test tools.

## The change loop

1. Work in a worktree and push the branch.
2. Deploy the branch to staging and run the real path there: a real turn, a
   restart, clicks and slash commands through `tester_interact`.
3. Merge.
4. Put staging back on `main`.
5. Deploy production (`npm run redeploy` in its checkout), plus a bridge
   rollout or sessiond restart if that code changed.
6. Check production's logs for the behaviour you changed.
