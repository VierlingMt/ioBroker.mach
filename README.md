<img src="admin/mach.png" width="96" alt="Logo" align="right">

# ioBroker.mach

ioBroker adapter for **Adria caravans and motorhomes with the MACH box**
(MACH 2.0 / "MACH by Adria Mobil", manufactured by Solvesall d.o.o.).
Manufacturer page: [MACH app – Adria Mobil](https://www.adria-mobil.com/mach-app).

It connects to the MACH cloud with your own MACH account, the same way the
app does over LTE, and makes the box values available in ioBroker.

> **Unofficial project.** This adapter is not made, endorsed or supported by
> Adria Mobil or Solvesall. "Adria" and "MACH" are names of their respective
> owners and are used here only to describe what the adapter works with.
> The protocol was worked out independently to make the box interoperable
> with ioBroker. The manufacturer can change it at any time, which may break
> the adapter. Use at your own risk – especially when switching devices
> (heating!) remotely.

*A German summary is available in [docs/de/README.md](docs/de/README.md).*

## Features

- Reads **all values** of the box: at connect, every 15 minutes and a few
  seconds after every change the box reports. Values are named like in the
  app (`values.AIR_HEATER_TEMPERATURE`, `values.FRIDGE_VALUE`,
  `values.GAS_BOTTLE_LEVEL`, …), with scaling and value lists from the
  value table your own account downloads from the MACH backend.
- Changes reported by the box are applied immediately (push).
- **Everything the box allows can be switched** (from 2.0.0, beta): heating,
  air conditioning, fridge, boiler, water pump, lights and light scenes,
  energy source and more – directly on `values.<NAME>` as switch, slider or
  selection. What is writable comes from the value table of your box, so it
  works for every Adria model. See [Writing values](#writing-values).
- `control.reboot` restarts the box like "Restart MACH" in the app
  (at most once every 10 minutes).
- Sensitive values (Bluetooth PIN, SIM ICCID/IMSI, modem IMEI) are
  deliberately **not** stored as states.


## Requirements

- An Adria vehicle with a MACH box and **active LTE connectivity** (the
  adapter talks to the box through the MACH cloud, not via Bluetooth/WiFi)
- A MACH app account that has the vehicle paired
- ioBroker with js-controller ≥ 5, admin ≥ 6, Node.js ≥ 18

## Installation

Install the adapter from the ioBroker admin: Adapters → search for "mach".
It is available there once it has been added to the ioBroker repositories.

## Configuration

| Field      | Value                                                       |
|------------|-------------------------------------------------------------|
| `username` | e-mail of your MACH app account                             |
| `password` | password (stored encrypted)                                 |
| `machId`   | 12 hex characters, e.g. `A1B2C3D4E5F6` (app → device settings) |
| Write access | `off`, `operation` (default) or `setup` – see below |
| Additionally writable | own list of names, `*` allowed |
| Never writable | own list of names, `*` allowed |

## Writing values

From 2.0.0 every value the box allows to change is writable under
`values.<NAME>` – write it with `ack=false` like any other state:

| Value in the box | State | Example |
|---|---|---|
| on/off | `boolean`, role `switch` | `values.FRIDGE_VALUE = true` |
| selection | `number` with `states` | `values.WATER_HEATER_TEMPERATURE = 2` (boost) |
| number with range | `number` with `min`/`max`/`step` | `values.LIGHT_GROUP_1_BRIGHTNESS = 40`, `0` = off |
| action without state | one button per action | `values.LIGHT_SYSTEM_MEMORY_1_RESTORE = true` |
| text | `string` | only in "setup" |

The adapter checks range, step and selection, sends the commands one after
another and then asks the box for the value. The state gets `ack=true` with
the value the **box** reports. If the box rejects or does not confirm
within 20 s, the state returns to the last value of the box.

**Write access** (instance settings):

- **operation** (default): everything the value table marks as writable,
  except texts and setup values.
- **setup**: additionally sensor pairing (tyre, gas, battery), limits,
  sensor addresses and names.
- **off**: read only.
- **Additionally writable**: your own list for things the value table does
  not mark as writable or that your model has in addition, e.g.
  `MY_VALUE, LIGHT_*`. Only works for values with a known type.
- **Never writable**: your own blocklist, e.g. `POWER_CONTROL_*`.

Parts that **move or trigger something** are only writable when you add
their name to "Additionally writable" yourself – the setting "setup" is not
enough: slide-outs, awnings, lifts (bed, TV, bike, garage), steps, roof,
satellite antenna, winch, front blind, doors, drain valves, central locking
and generator. Switching them remotely without seeing them can harm people
or the vehicle. Most caravans do not have them; the value table contains
them for motorhomes and trailers.

Some values can **never** be written, whatever the settings: LTE on/off,
all SIM settings (slot, APN, user, password, PIN), the Bluetooth PIN,
bootloader/application mode and debug switches. A wrong value there can cut
the LTE connection or brick the box – with no way back remotely.

`named.Heizung_Schalter` and `named.Heizung_Sollwert` keep working as
before.

## States

| State | Meaning |
|---|---|
| `info.connection` | connected to the box |
| `info.lastAllValuesAt` | time of the last full state (ms) – use this to detect stale data |
| `info.lastFrameAt` | time of the last message from the box (ms) |
| `values.<NAME>` | every value of the box, named like in the app; writable ones as switch/slider/selection |
| `values.<NAME>_<ACTION>` | buttons for actions without state (e.g. light scene save/restore) |
| `named.*` | older names from the first versions (kept for existing scripts); `Heizung_Schalter` and `Heizung_Sollwert` are writable |
| `control.reboot` | button: restart the box |
| `tlv.*`, `frames.*` | raw values the adapter cannot name yet (for analysis) |

The value table itself is saved to `0_userdata.0/mach/drivers.json` for
reference.

**Tip for automations:** only act on values when `info.lastAllValuesAt` is
recent (e.g. younger than 30 minutes). If the box loses LTE, the last values
stay in ioBroker.

## How it works

See [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Contributing

Reports from other Adria models are very welcome – especially which values
your box reports (`values.*`) and whether the heating can be switched.
Please **never** post your password, `machId`, `sharedSecret`, tokens or
raw captures in issues.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 2.0.0-beta.2 (2026-11-14)

- Negative temperatures in `named.Innentemperatur` and
  `named.Aussentemperatur` are decoded with sign: -3 °C no longer shows
  as 253 °C. The `values.*` states were already correct.

### 2.0.0-beta.1 (2026-11-01)

- While a write is pending, a different value reported by the box (often
  the old value arriving right after the command) no longer resets the
  state. The adapter asks again after 3 s and only takes the box's value
  with a warning when the 20 s deadline passes.
- Note: some boxes report the external light brightness scaled
  (60 % of the value sent); the state then shows what the box reports.

### 2.0.0-beta.0 (2026-11-01)

**Breaking:** on/off values under `values.*` are now `boolean` (was text
`"on"`/`"off"`), other selections are `number` with `states` (was the text
of the selection). Adjust scripts that compare with `"on"` or with the text.
Existing objects are converted on the next start.

- Writing every value the box allows (see "Writing values"), generic from
  the value table: selections, numbers, texts, actions.
- Write access setting (off / operation / setup) plus own allow and block
  lists; values that could cut the connection are always blocked; moving
  parts, valves, locks and generator need an explicit own allow entry.
- Commands are queued, checked against range/step/selection and confirmed by
  asking the box for the value (GET_DEVICE_VALUE_FOR_VALUEID).
- Values from push messages go to `values.*` right away.

### 1.3.7 (2026-10-29)

- Folders are also created at start for states from older versions that no
  longer receive values (e.g. `frames.*`), so every object has its parents.

### 1.3.6 (2026-10-28)

- Read-only states no longer use `switch.*` or `level.*` roles: on/off values
  are `indicator`, temperatures `value.temperature`, everything else `value`.
  Objects created by older versions are updated on the next start.
- Every path segment now has its own object: `values`, `tlv` and `frames` are
  folders, `tlv.<id>` and `frames.<id>` channels. Created on the next start
  for existing installations.

### 1.3.5 (2026-10-28)

- No functional changes. Releases are tagged by a push again, so every
  release has a tag-triggered test run as the ioBroker repository check
  expects.

### 1.3.4 (2026-10-28)

- Settings page translations (`admin/i18n`) are now part of the npm package.
- Requires admin 7.6.20.

### 1.3.3 (2026-10-28)

- Settings page translated into 11 languages, with responsive layout.
- Timers are managed by ioBroker (`this.setTimeout`/`this.setInterval`).
- Requires Node.js 22, js-controller 6.0.11 and admin 7.6.17.
- Releases are published to npm via trusted publishing.

### 1.3.2 (2026-10-28)

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

## License

MIT License

Copyright (c) 2026 Martin Vierling <vierling.martin@gmail.com>

The adapter is free software under the [MIT License](LICENSE): use it,
copy it, change it and share it, also commercially, as long as the license
text stays with it.

**What this license covers – and what not:**

- It covers only the code and documentation **written for this
  repository** (adapter, protocol description, logo).
- The author has **no rights** to the MACH app, the MACH box firmware, the
  MACH backend or any of their code, data or trademarks. These belong to
  Solvesall d.o.o. and Adria Mobil d.o.o. and are **not** licensed here.
- No code, files or data of the MACH app are included in this repository.
  The value table is downloaded at runtime from the MACH backend with the
  user's own account and is not part of this project.

See also [NOTICE](NOTICE).
