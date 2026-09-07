# Seam systemd operations and rollback

Seam and the Pronoa Playwright MCP run as separate systemd services in
production. This gives them separate cgroups and prevents an OOM-killed
Chromium child from causing systemd to stop Seam or every PM2-managed helper.

Production cutover completed on 2026-09-06. Both native services are enabled;
PM2 retains only helper processes, and its checked-in `OOMPolicy=continue`
drop-in is installed and active. The migration sections below remain as the
canonical rollback/recovery record.

The unit templates are host-specific. They assume:

- checkout: `/home/ubuntu/Projects/seam-acp`
- Node: `/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node`
- Playwright MCP: `/home/ubuntu/.nvm/versions/node/v22.22.2/bin/playwright-mcp`
- Pronoa checkout: `/home/ubuntu/Projects/pronoa`
- Seam health port: `3000`
- Playwright MCP port: `8766`

## Normal operations

Apply code changes or request a safe restart through the drain sentinel:

```bash
cd /home/ubuntu/Projects/seam-acp
npm run redeploy
```

The script builds first and writes `data/.restart-pending`. Seam stops new work,
waits for admitted work to finish (bounded by the configured drain timeout),
removes the sentinel, signals itself with SIGTERM, completes its bounded
shutdown, and lets systemd restart it.

The shutdown intentionally has a five-second hard exit fallback. If an HTTP
connection keeps the listener open through that tail, systemd may record the
old process as `status=1/FAILURE` before `Restart=always` starts the replacement.
Treat the redeploy as successful only after the PID changes, the sentinel is
gone, and `/health` responds; the fallback line alone is not evidence of a
crash.

Read-only status and logs:

```bash
systemctl status seam-acp --no-pager
journalctl -u seam-acp -n 100 --no-pager
journalctl -u seam-acp -f
curl -fsS http://127.0.0.1:3000/health
```

Do not stream raw `pm2 jlist`, `pm2 prettylist`, or `pm2 env` output into chat
or logs. Those commands include application environment variables and may
expose credentials. Use `pm2 ls --no-color`, narrowly scoped `systemctl show`,
or process/cgroup inspection instead.

An emergency restart interrupts live turns and should be run by a human over
SSH, never by an agent inside Seam:

```bash
sudo systemctl restart seam-acp
```

Restarting Playwright interrupts its active browser sessions but not Seam:

```bash
sudo systemctl restart pronoa-playwright-mcp
```

## One-time preflight

Do these checks before changing either running process:

```bash
cd /home/ubuntu/Projects/seam-acp
git status --short --branch
test -x /home/ubuntu/.nvm/versions/node/v22.22.2/bin/node
test -x /home/ubuntu/.nvm/versions/node/v22.22.2/bin/playwright-mcp
test -x /home/ubuntu/.cache/ms-playwright/chromium-1226/chrome-linux/chrome
test -d /home/ubuntu/Projects/pronoa
sudo systemd-analyze verify ops/systemd/seam-acp.service ops/systemd/pronoa-playwright-mcp.service
pm2 describe seam-acp
pm2 describe pronoa-playwright-mcp
curl -fsS http://127.0.0.1:3000/health
sudo ss -ltnp 'sport = :8766'
```

Install the templates without starting or enabling them. Keeping them disabled
until their PM2 process is removed prevents duplicate Discord connections and
port conflicts on reboot.

```bash
sudo install -o root -g root -m 0644 ops/systemd/seam-acp.service /etc/systemd/system/seam-acp.service
sudo install -o root -g root -m 0644 ops/systemd/pronoa-playwright-mcp.service /etc/systemd/system/pronoa-playwright-mcp.service
sudo systemctl daemon-reload
sudo systemctl is-enabled seam-acp pronoa-playwright-mcp
```

Both `is-enabled` results must be `disabled` before the cutover.

## Cut over Playwright first

Run from an SSH shell. The source `ecosystem.config.cjs` definition stays in the
repository during the initial observation window so rollback remains simple.

```bash
cd /home/ubuntu/Projects/seam-acp
pm2 delete pronoa-playwright-mcp
pm2 save
sudo systemctl start pronoa-playwright-mcp
sudo systemctl status pronoa-playwright-mcp --no-pager
sudo ss -ltnp 'sport = :8766'
curl -sS -o /dev/null -w 'playwright_http=%{http_code}\n' http://127.0.0.1:8766/mcp
sudo systemctl enable pronoa-playwright-mcp
```

An unauthenticated GET currently returns HTTP 403; that still proves the
loopback listener is answering. Confirm the service remains active after the
probe:

```bash
systemctl is-active pronoa-playwright-mcp
journalctl -u pronoa-playwright-mcp -n 100 --no-pager
```

Rollback Playwright if the unit or listener is unhealthy:

```bash
sudo systemctl disable --now pronoa-playwright-mcp
cd /home/ubuntu/Projects/seam-acp
pm2 start ecosystem.config.cjs --only pronoa-playwright-mcp
pm2 save
pm2 describe pronoa-playwright-mcp
```

## Cut over Seam

Wait until Seam has no important live turns, then run this from SSH. The Discord
bot will be briefly offline between `pm2 delete` and `systemctl start`. Do not
run these commands from a Seam agent turn: deleting Seam from PM2 terminates the
very process hosting that turn.

```bash
cd /home/ubuntu/Projects/seam-acp
pm2 delete seam-acp
pm2 save
sudo systemctl start seam-acp
sudo systemctl status seam-acp --no-pager
curl -fsS http://127.0.0.1:3000/health
sudo systemctl enable seam-acp
```

Verify the new process, its restart settings, and the cgroup split:

```bash
systemctl is-active seam-acp pronoa-playwright-mcp
systemctl show seam-acp -p MainPID -p Restart -p RestartUSec -p OOMPolicy -p ControlGroup
systemctl show pronoa-playwright-mcp -p MainPID -p Restart -p RestartUSec -p OOMPolicy -p ControlGroup -p Nice -p CPUWeight -p IOWeight -p OOMScoreAdjust -p MemoryHigh -p MemoryMax -p MemorySwapMax
pm2 describe seam-acp
pm2 describe pronoa-playwright-mcp
journalctl -u seam-acp -n 100 --no-pager
```

The two `pm2 describe` commands must report that the processes do not exist.
The two systemd services must have distinct control groups.

Rollback Seam if health or Discord startup fails:

```bash
sudo systemctl disable --now seam-acp
cd /home/ubuntu/Projects/seam-acp
pm2 start ecosystem.config.cjs --only seam-acp
pm2 save
pm2 describe seam-acp
curl -fsS http://127.0.0.1:3000/health
```

## Remaining PM2 helpers

The production drop-in is already installed and active. These idempotent
commands document how to restore it after host rebuild or configuration drift.
It changes
the remaining PM2 cgroup from `OOMPolicy=stop` to `continue` and replaces its
100 ms daemon restart delay with five seconds.

```bash
sudo install -d -o root -g root -m 0755 /etc/systemd/system/pm2-ubuntu.service.d
sudo install -o root -g root -m 0644 ops/systemd/pm2-ubuntu-oom-policy.conf /etc/systemd/system/pm2-ubuntu.service.d/oom-policy.conf
sudo systemctl daemon-reload
systemctl show pm2-ubuntu -p OOMPolicy -p RestartUSec
```

Do not restart `pm2-ubuntu.service` merely to apply the drop-in: that would
interrupt every remaining PM2 helper. Apply it during a maintenance window if
the live properties do not update after `daemon-reload`.

## Resource-limit observations

The Playwright unit initially uses a 4 GiB soft memory threshold, a 6 GiB hard
memory limit, and at most 1 GiB of swap. `OOMPolicy=continue` means a cgroup OOM
does not make systemd stop every remaining process in the service. The main MCP
process is restarted only if it exits.

Inspect pressure and OOM counters before changing the limits:

```bash
cat /sys/fs/cgroup/system.slice/pronoa-playwright-mcp.service/memory.current
cat /sys/fs/cgroup/system.slice/pronoa-playwright-mcp.service/memory.events
journalctl -u pronoa-playwright-mcp --since today --no-pager
```

After an observation window, remove the Seam and Playwright entries from
`ecosystem.config.cjs` so a future `pm2 start ecosystem.config.cjs` cannot create
duplicates. Keep the rollback commands or the pre-cutover commit available.
