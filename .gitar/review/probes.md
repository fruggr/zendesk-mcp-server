# Probe scripts (`scripts/probe-*.ts`)

These instructions apply only to files matching `scripts/probe-*.ts`.

Probes are disposable, read-only spike scripts run by hand (`docs/live-testing.md`, Probes). On these files, flag only:

- a call that writes to Zendesk;
- the token printed or exported;
- a count that would skew the answers the probe exists to give.

Do not raise style, robustness, comment or edge-case output-hygiene findings on them: the person running the probe redacts its output before posting it.
