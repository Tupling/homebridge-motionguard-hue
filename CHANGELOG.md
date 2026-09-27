# Changelog

## [0.6.1] - 2026-09-27

- Added official GitHub repository metadata.
- Added PayPal funding metadata and GitHub funding configuration.
- Added public release documentation and branding URLs.
- No motion-lighting runtime behavior changes from v0.6.0.

All notable changes to MotionGuard for Hue are documented here.

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
