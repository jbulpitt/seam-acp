# Generic systemd deployment

These units are deployment-neutral examples for running Seam's controller,
local bridge, durable session supervisor, and optional CLI health reporter.
Concrete users, checkout paths, Node paths, environment files, schedules, and
additional services belong in the private `docs/local/` operator notes.

## Prepare the examples

The checked-in units use conventional placeholders:

- service account: `seam`
- checkout: `/opt/seam-acp`
- state home: `/var/lib/seam`
- repositories: `/srv/repos`
- Node resolved from the unit's `PATH` via `/usr/bin/env`
- environment: `/etc/seam/seam-acp.env`

Copy the units to a temporary directory and replace those values for the target
host. Validate the rendered copies with `systemd-analyze verify` before
installing them under `/etc/systemd/system`. Keep secrets only in the
root-readable environment file.

## Service boundaries

- `seam-acp.service` owns Discord, orchestration, and persistence.
- `seam-local-bridge.service` connects the controller host as a bridge.
- `seam-sessiond.service` owns agent processes and survives controller or
  bridge restarts. Its `KillMode=process` is deliberate.
- `seam-cli-health-report.service` and its timer are optional, read-only
  reporting examples. Choose the actual schedule in the rendered unit.

Browser automation, PM2 helpers, and other applications should use separate
services and cgroups. Their configuration is not part of the public Seam
deployment contract.

## Lifecycle

Enable the session supervisor and local bridge before the controller. Apply
Seam code changes with `npm run redeploy`; do not directly restart
the controller from an active agent turn. The command builds, runs the bounded
shutdown quiesce, and lets the supervisor restart the service. Running turns
stay with sessiond and reattach.

Use read-only checks such as:

```bash
systemctl status seam-acp seam-local-bridge seam-sessiond --no-pager
journalctl -u seam-acp -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/health
```

A deployment may need elevated permissions to read journals or install units;
document those host-specific commands in `docs/local/`.
