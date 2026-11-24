# Older changes
## 1.3.7 (2026-10-29)

- Folders are also created at start for states from older versions that no
  longer receive values (e.g. `frames.*`), so every object has its parents.

## 1.3.6 (2026-10-28)

- Read-only states no longer use `switch.*` or `level.*` roles: on/off values
  are `indicator`, temperatures `value.temperature`, everything else `value`.
  Objects created by older versions are updated on the next start.
- Every path segment now has its own object: `values`, `tlv` and `frames` are
  folders, `tlv.<id>` and `frames.<id>` channels. Created on the next start
  for existing installations.

## 1.3.5 (2026-10-28)

- No functional changes. Releases are tagged by a push again, so every
  release has a tag-triggered test run as the ioBroker repository check
  expects.

## 1.3.4 (2026-10-28)

- Settings page translations (`admin/i18n`) are now part of the npm package.
- Requires admin 7.6.20.

## 1.3.3 (2026-10-28)

- Settings page translated into 11 languages, with responsive layout.
- Timers are managed by ioBroker (`this.setTimeout`/`this.setInterval`).
- Requires Node.js 22, js-controller 6.0.11 and admin 7.6.17.
- Releases are published to npm via trusted publishing.

## 1.3.2 (2026-10-28)

First public release. Earlier versions were developed and tested privately
on one box (Adria Adora, MACH V2, LTE).

- Login via the MACH cloud, WebSocket with AES-128-CBC and HMAC-SHA1.
- Full state of the box at connect, every 15 minutes and shortly after
  every push message; values named from the value table of the backend
  (`values.*`).
- Heating on/off and target temperature can be written (verified live).
- `control.reboot` restarts the box (at most every 10 minutes).
- Bluetooth PIN, SIM ICCID/IMSI and modem IMEI are not stored as states.
- Logs show `machId` and user name only shortened; tokens never.
