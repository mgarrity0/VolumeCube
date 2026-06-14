# VolumeCube SD-card player firmware

One-time-flash player firmware for the QuinLED Dig-Octa Brainboard.
Each board reads its own `config.json` from the microSD card, lists
patterns from `/animations/*.bin`, and serves a phone-friendly web UI
on its IP so you can pick a pattern from your phone without
re-flashing the board.

## Workflow

1. **One-time flash this sketch on every Brainboard.** It's identical
   across boards — the board-specific layout (which outputs, which LED
   ranges) comes from the SD card's `config.json`, not the sketch.
2. **Bake patterns from VolumeCube → SD card.** In the desktop app:
   Output panel → Mode = `SD card (multi-board)` → pick patterns →
   "Bake N patterns × M boards". You get an `exports/sdcard_<ts>/`
   folder with `BoardA/` and `BoardB/` subdirectories.
3. **Copy each Board* folder onto the matching board's microSD root.**
   The card layout the firmware expects is:
   ```
   /config.json
   /animations/
     harmonic-blob.bin
     jellyfish.bin
     plasma-globe.bin
     ...
   ```
4. **Power up the boards.** Board A (the sync master) hosts or joins
   the network and starts playing the last-selected pattern; followers
   lock onto Board A's frame clock within a couple of seconds.
5. **From your phone, open Board A's page.** Easiest in the field:
   browse to **`http://volumecube.local/`** — the board advertises that
   name over mDNS, so you never need to know its IP. (Standalone AP
   mode: first join the `VolumeCube` Wi-Fi, password `volumecube`.)
   Tap a pattern — every board switches in the same frame. Drag the
   brightness slider — the whole cube follows. You never talk to
   follower boards; they have a debug page but it's not needed.

### Finding the cube with no serial cable (field use)
You will not always have a laptop + serial monitor. In order of ease:
1. **`http://volumecube.local/`** — works on iOS/Safari out of the box
   and on Android 12+ in Chrome. The board (master) always answers to
   this name on whatever network it joined, including its own AP.
2. **Your phone's hotspot device list** — if the cube joined your phone
   hotspot, the hotspot settings list connected devices with their IP.
3. **A network scanner app** (e.g. Fing) — shows every device's IP;
   look for the ESP32 / espressif vendor.
   (Followers advertise `volumecube-<id>.local`, but you only ever need
   the master's page.)

## Adding / removing patterns later

- **Add a pattern:** Bake it from VolumeCube, drop the new `.bin` onto
  the SD card. Reboot the board (or just refresh the phone UI — the
  next `/api/list` call picks up new files).
- **Remove a pattern:** Delete the `.bin` from the SD card.
- **Change a pattern's bake (duration, fps, parameters):** Re-bake in
  VolumeCube, overwrite the `.bin` on the card.

No re-flashing needed for any of the above.

## One-time setup — Arduino IDE

1. Install ESP32 board support (Boards Manager → search "esp32" →
   "esp32 by Espressif Systems").
2. Install these libraries from the Library Manager (exact names —
   there are abandoned forks with similar names):
   - **FastLED** (by Daniel Garcia)
   - **ArduinoJson** (by Benoit Blanchon — v6 or v7 both work; v7
     prints deprecation warnings about `DynamicJsonDocument`, which
     are harmless)
   - **ESP Async WebServer** (by ESP32Async — the maintained fork)
   - **Async TCP** (by ESP32Async; the IDE offers to install it
     automatically as a dependency of ESP Async WebServer — say yes)
3. Open `volumecube_player.ino`.
4. Pick a networking mode (see below) and set `WIFI_SSID` /
   `WIFI_PASSWORD` accordingly. Optionally check `SD_CS_PIN` matches
   your Brainboard revision (5 is the standard).
5. Tools → Board → "ESP32 Dev Module".
6. Tools → Port → COMx (whichever appears when you plug in).
7. Upload.

## Networking modes

The boards need NO router, switch, or other infrastructure — just a
phone. Three ways to run it, chosen by what you put in the WiFi
credential constants (same constants on every board):

| Mode | Credentials | How it works |
|---|---|---|
| **Standalone AP** (WLED-AP style) | Leave the `YOUR_WIFI_SSID` placeholder untouched | Board A hosts a single network named `VolumeCube` (password `volumecube`); follower boards join it automatically. Your phone connects to `VolumeCube` and opens `http://192.168.4.1/` — one network, one page, the whole cube. Zero config, fully portable. |
| **Phone hotspot** | Your phone's hotspot SSID + password | All boards join your phone's hotspot. Control via Board A's IP (printed on its serial monitor, or check the hotspot's connected-devices list). |
| **Home WiFi** | Your house SSID + password | All boards join the LAN; the cube keeps running when your phone leaves the house. If the join fails, Board A falls back to hosting `VolumeCube` and followers find it there — the cube is never unreachable. Caveat: if your router has "AP/client isolation" enabled, device-to-device sync broadcasts are blocked — disable isolation or use standalone mode. |

## Multi-board frame sync

The board whose `config.json` says `"boardId": "A"` is the **sync
master**; every other board is a **follower**. Before each frame the
master broadcasts a tiny UDP packet (port 22083): which file it's
playing, which frame number, the brightness, and a playing flag.
Followers don't keep their own frame clock while packets flow — they
render the frame they're told to. That gives you:

- **One control surface.** The play/brightness controls exist *only* on
  Board A; follower pages are read-only status. There's no way to
  accidentally desync the cube by poking a follower.
- **Atomic switching.** Tapping a pattern lands on every board in the
  same frame — no window where the halves play different content.
- **Zero drift.** Followers are frame-locked, not free-running, so the
  crystal-oscillator drift that tears free-running boards apart over an
  evening can't happen.
- **Self-healing.** If sync packets stop (master rebooting, WiFi blip),
  followers free-run their current animation at its own fps so the cube
  doesn't freeze, then snap back to lock the instant packets resume. A
  follower that boots before the master keeps retrying the join.
- **Graceful mismatch.** If a follower's card is missing the file the
  master switched to (you updated one card and forgot the other), it
  keeps free-running whatever it already had open and logs the mismatch
  on serial — wrong but moving beats frozen-dark. A failed open never
  tears down the running animation.
- **Split-network recovery.** If a follower joined home WiFi but the
  master fell back to its own AP (router rebooted mid-boot), the
  follower notices 60 s of silence and reboots to re-run the full
  join hunt, finding the master's AP on the second pass. (Only arms
  once a follower has *ever* heard the master, so a single-board bench
  test free-runs forever instead of reboot-looping.)

Scaling: nothing is pairwise. Any number of follower boards lock to
the one master — a future 4-board build needs zero firmware changes.

Note: the sync port is unauthenticated (any device on the same network
can send a valid packet). For a home art piece on your own WiFi/AP
that's fine; if you ever put the cube on an untrusted network, the
followers will honor brightness/pattern commands from anything that
speaks the protocol. NVS flash writes are debounced (≤ once / 10 s) and
failed opens are rate-limited, so a packet flood can't wear the flash
or thrash the SD bus, but it could still drive the lights.

## Why this isn't WLED

WLED gives you ~100 built-in effects + DDP/sACN streaming, which is
great, but it doesn't run **your** VolumeCube patterns. This firmware
is the bridge: VolumeCube renders the math, the bake step writes raw
RGB to a `.bin` file, this firmware plays it back. You get the exact
same look on the cube as in the simulator. The trade-off is that
playback is fixed (no live parameter tuning) — for live control of the
parameters, fire up the NUC streamer (`pnpm stream`) instead.

## Storage budget

Each `.bin` file is `(16 + framecount × leds × 3)` bytes. For a
typical Brainboard slice (500 LEDs) and a 5-second loop at 30 fps:

```
16 + 150 frames × 500 LEDs × 3 bytes = ~220 KB per pattern
```

A 32 GB microSD card fits ~150,000 patterns at that size. You will
not hit the limit.
