# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a suspected security vulnerability.

Use GitHub's private vulnerability reporting feature for this repository when available. If private reporting is unavailable, contact the maintainer through the GitHub profile linked in this repository and avoid including credentials, Hue application keys, HomeKit setup codes, or private network details in public posts.

## Security model

MotionGuard for Hue is designed to operate locally:

- runtime Hue traffic is HTTPS only;
- the configured Hue TLS certificate fingerprint is pinned;
- Hue Bridge identity is checked;
- the Hue application key is sent only to the configured private/link-local Hue Bridge;
- the runtime plugin opens no additional inbound network listener;
- there is no analytics or intentional telemetry;
- custom-UI light discovery runs through Homebridge's local plugin UI helper.

A Homebridge host, Apple Home environment, router, Hue Bridge, or third-party motion-source plugin can still affect the overall security boundary. Keep those components updated and do not expose Homebridge administration ports directly to the public internet.
