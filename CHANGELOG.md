# Changelog

## 0.8.2

- Fixed HomeKit/HAP accessory-name warnings by replacing the Unicode MotionGuard zone separator with an ASCII-safe hyphen.
- Added HomeKit name sanitization for generated zone accessory names so copied punctuation or symbols in zone names do not prevent accessories from being added to Apple Home.
- No Hue runtime, restore, zone identity, or automation behavior changes.

## 0.8.1

- Removed the experimental Direct Ring provider and `ring-client-api` dependency after npm audit reported high-severity findings in its transitive WebRTC/IP dependency chain.
- Retained persistent Hue connections, Hue API v2 live-state caching, parallel motion writes, parallel restore, and performance timing logs.
- Preserved all existing Apple Home Motion Trigger identities and zone configuration compatibility.
- Configuration UI removes stale Direct Ring credentials/settings when the plugin configuration is next saved.


## 0.8.0

- Added a low-latency Hue path with persistent pinned-TLS connections.
- Added Hue API v2 event-stream state caching so motion snapshots normally avoid a bridge GET.
- Changed motion activation and restore writes to run concurrently instead of sleeping 110 ms per light.
- Added per-trigger performance timing logs.
- Added optional Direct Ring Fast Trigger using a dedicated Ring refresh token and per-zone camera mappings.
- Preserved existing Apple Home Motion Trigger services and stable accessory identities as the fallback/parallel trigger path.
- Added persistent handling of Ring refresh-token rotation in Homebridge accessory context.

## [0.7.1] - 2026-09-28

### Changed
- Reworked Apple Home presentation to one MotionGuard controller accessory per zone while preserving each zone's existing Motion Pulse accessory UUID.
- Added HomeKit exposure profiles: Minimal, Standard (recommended), and Advanced.
- Removed brightness, color temperature, delay presets, security-mode switches, and other configuration clutter from the default Apple Home experience.
- Added per-zone Enabled, Pause, Night Only, Motion Trigger, and Override Active controls in the Standard profile.
- Added Protect Manual Changes, Test, and Restore Now to the Advanced profile.
- Pause is now per-zone and its duration is configurable from 5 minutes to 24 hours.
- Migrates legacy global accessory state and active-override recovery data into the primary zone controller, then removes the obsolete global HomeKit settings accessory.
- Added Homebridge UI fields for global brightness, white temperature, restore delay, Night Only default, manual-change protection, operating mode, HomeKit exposure profile, and Pause duration.

### Compatibility
- Package/platform IDs remain unchanged.
- Existing Motion Pulse accessory identities are retained, so existing Apple Home motion automations should stay attached.
- Existing v0.7.0 Hue device/multi-service support and exact-state restore behavior remain intact.

## [0.7.0] - 2026-09-28

### Added
- Device-aware Hue API v2 discovery that groups `light` services under their owning physical Hue `device`.
- Generic multi-service fixture support for dual-zone and future multi-light Hue fixtures without hard-coding a product model.
- Whole-fixture selection plus individual light-service selection in the Homebridge custom UI.
- Optional per-light-service motion brightness and color-temperature overrides keyed by stable Hue v2 light-service UUID.
- Device Inspector showing device UUID, model/firmware metadata, service IDs, service names, and light-service UUIDs.
- Runtime timezone, sunrise, sunset, and current Night Only diagnostic logging at startup.
- Multi-service fixture unit tests and configuration migration coverage.

### Compatibility
- Existing package/platform IDs remain `homebridge-hue-motion-restore` / `HueMotionRestore`.
- Existing zones and HomeKit Motion Pulse accessory identities are preserved.
- Existing single-service fixtures continue to use the same snapshot, override, manual-change protection, and exact-restore path.
- v0.7.0 has API-model test coverage for dual-service fixtures; physical Dymera hardware validation is still required before public release.

## [0.6.1] - 2026-09-26

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
