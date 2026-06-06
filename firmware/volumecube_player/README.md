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
4. **Power up the boards.** Each one connects to your WiFi, prints its
   IP on the serial monitor, and starts playing the last-selected
   pattern (or the first `.bin` it finds if nothing was selected
   before).
5. **From your phone, open `http://<board-ip>/`** on the same WiFi.
   Tap a pattern to switch; drag the brightness slider; done. The UI
   takes ~3 KB and is served straight from the firmware.

## Adding / removing patterns later

- **Add a pattern:** Bake it from VolumeCube, drop the new `.bin` onto
  the SD card. Reboot the board (or just refresh the phone UI — the
  next `/api/list` call picks up new files).
- **Remove a pattern:** Delete the `.bin` from the SD card.
- **Change a pattern's bake (duration, fps, parameters):** Re-bake in
  VolumeCube, overwrite the `.bin` on the card.

No re-flashing needed for any of the above.

## One-time setup — Arduino IDE

1. Install ESP32 board support (Boards Manager → search "esp32").
2. Install these libraries from the Library Manager:
   - **FastLED**
   - **ArduinoJson**
   - **ESPAsyncWebServer**
   - **AsyncTCP** (dependency of ESPAsyncWebServer)
3. Open `volumecube_player.ino`.
4. Edit the WiFi credentials at the top of the file (`WIFI_SSID`,
   `WIFI_PASSWORD`). Optionally check `SD_CS_PIN` matches your
   Brainboard revision (5 is the standard).
5. Tools → Board → "ESP32 Dev Module".
6. Tools → Port → COMx (whichever appears when you plug in).
7. Upload.

## Two-board sync

For the simplest setup, both boards run identical firmware and react
independently. When you tap a pattern on the phone UI, both boards'
APIs receive the request within milliseconds of each other (the phone
UI knows about both IPs and fires parallel requests).

For an art piece this works fine. If you ever need frame-perfect sync
between boards (no visible drift across the seam), you'd add a UDP
broadcast: one board acts as master, sends a "current frame index"
packet every N frames, the slave reads it and seeks to match. Not in
this firmware version — file a request and we'll wire it up if you
need it.

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
