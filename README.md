# MotionGuard for Hue

![MotionGuard for Hue](https://raw.githubusercontent.com/Tupling/homebridge-motionguard-hue/main/branding/banner.png)

[GitHub](https://github.com/Tupling/homebridge-motionguard-hue) · [Issues](https://github.com/Tupling/homebridge-motionguard-hue/issues)


## v0.8.0 — Low-Latency Motion Path

Version 0.8.1 keeps the existing Apple Home Motion Trigger workflow and adds a faster Hue runtime. Hue light state is initialized locally and then maintained from the Hue API v2 event stream; when that live cache is healthy, motion snapshots do not wait on a fresh Hue light-list GET. Motion and restore commands are dispatched concurrently rather than sleeping between bulbs.

Performance timing is logged per trigger so you can distinguish upstream Apple Home motion-automation delay from MotionGuard/Hue processing.

### Security note for v0.8.1

The experimental Direct Ring provider introduced in v0.8.0 has been removed from v0.8.1 because its WebRTC dependency chain triggered high-severity npm audit findings. The Hue-side latency improvements remain intact, and Apple Home Motion Trigger continues to be the supported trigger path.

> Package/platform compatibility names remain `homebridge-hue-motion-restore` and `HueMotionRestore` so existing Homebridge configurations and HomeKit accessory identities continue to work.

## v0.7.1 — Cleaner Apple Home controls

v0.7.1 moves day-to-day operation into **one MotionGuard accessory per zone** and moves setup-heavy options back into the Homebridge UI. The existing Motion Pulse accessory UUID for each zone is reused, so Apple Home automations remain attached while the visible service is renamed **Motion Trigger**.

The recommended Standard profile exposes Enabled, Night Only, Pause, Motion Trigger, and Override Active. Minimal and Advanced profiles are also available. Pause is now per-zone and configurable from 5 minutes to 24 hours.

## v0.7.0 — Multi-service Hue fixtures

v0.7.0 makes Hue discovery **device-aware**. MotionGuard now groups Hue API v2 `light` services under their owning physical fixture instead of presenting every controllable service as an unrelated flat light. This is designed to support both ordinary single-service fixtures such as Appear and multi-service fixtures such as dual-zone wall lights.

For a multi-service fixture, the settings UI can:

- select the **entire fixture** at once;
- select only one individual light service;
- configure separate motion brightness and white-temperature overrides for each selected light service;
- inspect the physical device UUID, model, firmware, service IDs, and stable Hue v2 light-service UUIDs.

At runtime, each selected light service is snapshotted and restored independently. Shared-light collision protection also operates at the light-service UUID level, so two zones cannot simultaneously own the same controllable service.

The implementation is generic and does not identify a fixture by the word “Dymera.” It follows the Hue API v2 device → light-service relationship, which also makes it suitable for future Hue fixtures containing multiple controllable light services.

**Hardware validation note:** v0.7.0 includes simulated dual-service API tests, but a physical Dymera still needs to be connected and discovered before this build should be treated as publicly validated for that model.

### Night Only diagnostics

At startup, MotionGuard now logs the server timezone plus the calculated sunrise/sunset for the configured coordinates. This does not change the Night Only decision logic; it makes clock/location problems much easier to spot.

## v0.6.1 — Public release candidate

v0.6.1 prepares MotionGuard for Hue for public distribution: GitHub/npm metadata, public branding URLs, CI, security and contribution documentation, and Homebridge v2 / current Node LTS engine declarations. Runtime lighting behavior is unchanged from v0.5.3.

## v0.5.2 — Branding compatibility fix

v0.5.2 keeps the v0.5.0 custom UI loading path intact and embeds the settings-screen icon directly so Homebridge does not need to serve nested UI image assets. Runtime behavior is unchanged.

## v0.5.0 — Discovery, health, and per-zone Home controls

MotionGuard for Hue is a local-first Homebridge plugin that turns Philips Hue lights into state-preserving motion/security lighting using motion events already available in Apple Home.

It does **not** log in to Ring or require a second camera connection. Any HomeKit-compatible motion source can trigger a zone by turning that zone's **Motion Trigger** switch ON.

The lighting workflow is:

1. A camera or motion sensor detects motion.
2. Apple Home turns ON the matching zone's **Motion Trigger** switch.
3. MotionGuard snapshots the selected Hue light states.
4. Those lights change to the configured bright-white security state.
5. Additional motion extends the timer without replacing the original snapshot.
6. The exact previous state is restored when the timer expires.

The plugin preserves on/off state, brightness, color temperature, and XY color where supported. Manual-change protection can prevent the plugin from restoring over a light that someone changed while a motion override was active.

---

## What's new in v0.5.0

### New product name

The user-facing product name is now **MotionGuard for Hue**. The npm/package name and Homebridge platform alias are intentionally unchanged to preserve upgrades:

- package: `homebridge-hue-motion-restore`
- platform: `HueMotionRestore`

Existing Hue pairing credentials, cached accessories, zone IDs, and Apple Home automations remain compatible.

### Secure Hue light discovery

The custom Homebridge settings screen can now query the already-paired Hue Bridge and present discovered lights as selectable choices.

- Discovery uses Hue API v2.
- The same pinned TLS certificate fingerprint and Bridge ID checks used by runtime control are enforced.
- The Hue application key is sent only to the configured private/link-local Hue Bridge.
- The browser UI does not make direct network requests.
- A temporary Homebridge custom-UI helper process performs discovery through Homebridge's supported local IPC API.
- Selected lights are stored by stable Hue API v2 resource UUID when chosen through discovery.
- Manual names/IDs remain supported as a fallback.

### Bridge health

The settings screen now shows live Hue Bridge health after a discovery check:

- online/offline state;
- number of discovered lights;
- last check time;
- useful error text if pinned TLS, identity, authorization, or connectivity fails.

Runtime Hue inventory requests also maintain an internal bridge-health state used for logging and the Homebridge settings health card.

### Per-zone operational controls

v0.7.1 consolidates the earlier per-zone Test/Lighting Active presentation into configurable Apple Home exposure profiles. Standard exposes **Override Active**; Advanced additionally exposes **Test** and **Restore Now**.

---

## Dynamic Zone Manager

From **Homebridge → Plugins → MotionGuard for Hue → Settings**, users can:

- add zones;
- remove zones;
- rename zones;
- reorder zones;
- enable or disable zones;
- stage disabled zones with zero Hue lights;
- discover Hue lights from the paired bridge;
- assign/remove entire fixtures or individual light services with checkboxes;
- configure per-light-service brightness / white-temperature overrides when desired;
- inspect multi-service fixture topology and stable Hue v2 service UUIDs;
- use manual light names/IDs when needed;
- choose the primary zone used to preserve shared settings/recovery ownership;
- set per-zone brightness, color temperature, restore delay, Night Only behavior, and maximum override duration.

Every managed zone receives a permanent internal ID. Renaming a zone therefore does **not** create a new HomeKit identity or break the automation connected to that zone's Motion Trigger service.

### Staged zones

A zone can exist before its hardware does.

Example:

- `Garage` — disabled, zero lights
- `Front Door` — disabled, zero lights

After installing four Hue Appear fixtures, press **Discover / Refresh Lights**, select two lights for Garage and two for Front Door, enable the zones, save, and restart the child bridge.

No placeholder/fake Hue devices are required.

---

## Apple Home experience

MotionGuard v0.7.1 presents **one controller accessory per managed zone**. Existing Motion Pulse accessory UUIDs are reused during upgrade so existing Apple Home automations remain attached.

The default **Standard** profile exposes these services inside each zone accessory:

1. **Enabled** — enables or disables automatic motion lighting for that zone. Turning it OFF immediately restores an active override.
2. **Night Only** — controls the zone's runtime Night Only behavior.
3. **Pause** — temporarily suspends automatic motion for the configured Pause duration and then turns itself back off.
4. **Motion Trigger** — automation target. Turn this ON from an Apple Home motion automation. MotionGuard self-resets it.
5. **Override Active** — read-only motion-sensor status showing whether MotionGuard currently owns an active override snapshot for that zone.

The Apple Home accessory is named **`MotionGuard — <Zone Name>`**.

### Apple Home exposure profiles

Choose the profile in the MotionGuard Homebridge UI:

- **Minimal** — Enabled, Pause, Motion Trigger.
- **Standard — recommended** — Minimal plus Night Only and Override Active.
- **Advanced** — Standard plus Protect Manual Changes, Test, and Restore Now.

Brightness, white temperature, restore delay, operating mode, multi-service fixture configuration, and other setup options stay in the Homebridge UI instead of cluttering Apple Home.

### Pause

Pause is now **per zone**. Set the duration in the MotionGuard UI from 5 minutes to 24 hours. Enabling Pause restores that zone if it is currently overridden, blocks new automatic triggers, and automatically resumes when the timer expires. The pause deadline is persisted in the zone accessory context across Homebridge restarts.

### Operating modes

Operating mode is configured in the MotionGuard UI:

- **Normal** — uses normal settings and honors Night Only.
- **Night** — bypasses Night Only while retaining configured brightness.
- **Away** — allows automatic motion 24/7 and forces motion brightness to 100%.
- **Party** — blocks automatic motion and restores active overrides.

The motion source does not need to be Ring. Any Apple Home sensor/camera/automation that can turn the zone's Motion Trigger switch ON can trigger it.

---

## Example planned installation

### Garage

- Garage Appear Left
- Garage Appear Right

### Front Door

- Front Door Appear Left
- Front Door Appear Right

Automation flow:

```text
Garage camera motion
        ↓
MotionGuard — Garage / Motion Trigger ON
        ↓
Garage Appear Left + Right → configured motion white
        ↓
Override Active = detected
        ↓
restore previous state
        ↓
Override Active = clear

Front doorbell motion
        ↓
MotionGuard — Front Door / Motion Trigger ON
        ↓
Front Door lights → configured motion state
        ↓
restore previous state
```

---

## Apple Home automation setup

For each zone:

1. Open **Home → Automation → + → A Sensor Detects Something**.
2. Select the camera or motion sensor.
3. Choose **Detects Motion**.
4. Select the matching **MotionGuard — <Zone Name>** accessory and its **Motion Trigger** service.
5. Set **Motion Trigger** to **ON**.
6. Save.

Do **not** add an OFF action. MotionGuard resets Motion Trigger automatically so the next motion event can trigger it again.

---

## Exact-state restore and restart recovery

Before changing any Hue light, MotionGuard persists:

- the original light state;
- the expected motion state;
- override start time;
- restore deadline;
- hard-stop deadline.

If Homebridge restarts during an override, MotionGuard recovers the saved state and either re-arms the remaining restore timer or restores immediately if the deadline passed.

If a zone was removed or disabled while Homebridge was down, an active persisted override from that zone is restored during startup rather than abandoned.

With **Protect Manual Changes** enabled, failure to verify current Hue state causes restore to defer and retry instead of blindly overwriting a light.

### Shared-light protection

A Hue light may be listed in multiple zones, but two active zones do not control the same light simultaneously. If one zone already owns a light's active snapshot, a later zone safely skips that shared light until the first zone restores it.

---

## Backward compatibility

A legacy configuration remains valid:

```json
"lights": [
  "Outdoor Spotlight 1"
]
```

No Hue re-pairing is required when upgrading.

The Dynamic Zone Manager can convert that configuration into a managed zone while preserving the existing Ring Motion Pulse UUID.

Existing v0.3/v0.4 managed zone IDs and legacy-trigger ownership are preserved.

---

## Security model

Runtime Hue control and configuration discovery are intentionally local and narrowly scoped.

- Hue API v2 (`/clip/v2`) is used.
- The Hue application key is sent in the `hue-application-key` header, never in a URL.
- The configured Hue Bridge must use a private/link-local IP address.
- TLS 1.2 or newer is required.
- The Hue Bridge leaf certificate is pinned by SHA-256 fingerprint.
- Bridge certificate identity is verified against the configured Bridge ID.
- Fingerprint or Bridge ID mismatch blocks Hue traffic.
- There is no plaintext Hue fallback.
- Hue requests have an 8-second timeout.
- Oversized Hue responses are rejected.
- The runtime plugin opens no inbound listener and no additional TCP port.
- The browser configuration UI makes no direct network requests.
- The custom UI server is a temporary child process started by Homebridge only while the plugin settings UI is open.
- The UI server reuses the exact same pinned `HueClient` as runtime control.
- The only added production dependency is the official Homebridge `@homebridge/plugin-ui-utils` package, pinned to version `2.2.6`; it currently has no transitive npm dependencies.
- The Hue application key is not intentionally written to logs.

No software can guarantee that a system is impossible to compromise. The Homebridge host, router, Apple account/home hubs, Hue Bridge, and administrator credentials remain part of the security boundary.

Do not port-forward Homebridge or Hue services to the Internet.

---

## Secure Hue pairing

For first-time setup:

```bash
npm run hue-link -- 192.168.1.25
```

Verify the Bridge ID, press the physical Hue Bridge button, and press Enter when prompted. Keep the returned Hue application key private.

Upgrades from previous Hue Motion Restore / MotionGuard versions do not require pairing again.

---

## Ubuntu / native Homebridge local-plugin upgrade

If the working local plugin is located at:

```text
/var/lib/homebridge/local-plugins/homebridge-hue-motion-restore
```

extract and test the package:

```bash
rm -rf ~/Downloads/hmr050
mkdir -p ~/Downloads/hmr050
unzip ~/Downloads/homebridge-hue-motion-restore-0.7.1.zip -d ~/Downloads/hmr071
cd ~/Downloads/hmr071/homebridge-hue-motion-restore
export PATH="/opt/homebridge/bin:$PATH"
npm run check
```

Replace the existing source:

```bash
sudo rsync -a --delete ~/Downloads/hmr071/homebridge-hue-motion-restore/ /var/lib/homebridge/local-plugins/homebridge-hue-motion-restore/
sudo chown -R homebridge:homebridge /var/lib/homebridge/local-plugins/homebridge-hue-motion-restore
```

Install the pinned official custom-UI helper as the `homebridge` service user:

```bash
sudo -u homebridge env PATH="/opt/homebridge/bin:$PATH" /opt/homebridge/bin/npm ci --omit=dev --ignore-scripts --prefix /var/lib/homebridge/local-plugins/homebridge-hue-motion-restore
```

Then restart:

```bash
sudo hb-service restart
```

An existing symlink at:

```text
/var/lib/homebridge/node_modules/homebridge-hue-motion-restore
```

can remain in place.

After restart, open **Plugins → MotionGuard for Hue → Settings**. The screen should automatically perform a secure discovery check when valid Hue credentials are present.

---

## Self-test

Run:

```bash
npm run check
```

Expected result:

```text
core tests passed
zone and persistence tests passed
dynamic zone manager tests passed
v0.7.1 UI compatibility tests passed
multi-service fixture tests passed
v0.7.1 HomeKit UX tests passed
v0.7.1 HomeKit runtime migration tests passed
security tests passed
```

The suite checks:

- Hue state conversion and restore behavior;
- zone normalization and inheritance;
- dynamic/staged zone behavior;
- stable v0.3/v0.4 trigger migration;
- restart persistence;
- HomeKit exposure profiles, per-zone controls, and legacy Motion Trigger identity preservation;
- custom UI discovery wiring;
- Hue feature inventory normalization;
- bridge-health runtime wrapping;
- private-address enforcement;
- TLS/certificate-pinning guardrails;
- API-v2 header authentication;
- absence of plaintext HTTP and custom inbound listeners;
- absence of browser-side direct network calls;
- dependency allow-listing for the official Homebridge custom-UI helper.

---

## Current limitations

- Advanced Hue gradient segment/effect metadata is not currently snapshot/restored.
- Configuration changes take effect after the Homebridge child bridge restarts.
- Bridge health in the Homebridge settings screen is checked when the UI is opened/refreshed; it is not a high-frequency background monitor.

---

MotionGuard for Hue is an independent Homebridge project and is not affiliated with or endorsed by Signify/Philips Hue, Apple, or Ring/Amazon.
