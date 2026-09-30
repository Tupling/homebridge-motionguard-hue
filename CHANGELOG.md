# Changelog

All notable changes to MotionGuard for Hue are documented here.

## [0.7.0] - 2026-09-29

### Added
- Grouped Apple Home controls for every enabled MotionGuard zone.
- Native **Motion Lighting** light service with master enable, brightness, and white-temperature controls.
- Apple Home switches for **Night Only** and **Protect Manual Changes**.
- Discrete Apple Home restore-duration choices for 30 seconds, 60 seconds, 90 seconds, 2 minutes, and 5 minutes.
- Self-resetting **Test Motion Lighting** and **Restore Now** controls.
- Read-only **Lighting Active** status.
- Persistent HomeKit control-state storage and restart-safe active snapshot recovery.
- Hue API v2 event-stream state cache using `/eventstream/clip/v2`.
- Optional performance logging for trigger-to-Hue latency diagnostics.
- Focused runtime and security tests.
- Required Homebridge custom UI entry point with Hue bridge health and light discovery.

### Changed
- Hue HTTPS connections now use pinned, persistent keep-alive sockets instead of opening a new TLS session for every request.
- Multi-light motion and restore commands are dispatched concurrently.
- Initial motion snapshots use the live Hue cache and fall back to a direct bridge read only when needed.
- Repeated motion extends the active restore timer without replacing the original pre-motion snapshot.
- **Protect Manual Changes** verifies current state before restore and retries later rather than overwriting when state verification is unavailable.
- The legacy primary zone continues to reuse **Ring Motion Pulse** and **Hue Motion Restore** accessories when they already exist.
- Package validation now checks the runtime files and tests actually shipped in the repository.

### Security
- TLS certificate fingerprint pinning and Hue Bridge identity validation remain required.
- Hue Bridge addresses remain restricted to private or link-local IP space.
- Event-stream traffic uses the same pinned TLS agent as normal Hue API v2 requests.
- Hue event parsing now ignores `null` numeric values instead of coercing them to zero.

## [0.6.1] - 2026-09-27

- Added official GitHub repository metadata.
- Added PayPal funding metadata and GitHub funding configuration.
- Added public release documentation and branding URLs.
- No motion-lighting runtime behavior changes from v0.6.0.

## 0.6.0 - 2026-09-27

### Added
- Public GitHub/npm project metadata.
- Absolute GitHub-hosted branding URLs alongside bundled local branding assets.
- GitHub Actions CI for supported Node LTS releases.
- Security, contribution, and issue-reporting documentation.

### Changed
- Public product branding remains **MotionGuard for Hue** while the compatibility package/platform IDs remain `homebridge-hue-motion-restore` and `HueMotionRestore`.
- Engine declarations target Homebridge 2.x and current supported Node LTS releases.

### Unchanged
- Motion snapshot/restore behavior, dynamic zones, secure Hue pairing, TLS pinning, per-zone test/status, restart recovery, and HomeKit accessory identities.
