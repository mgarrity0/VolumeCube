// VolumeCube SD-card player firmware.
//
// One sketch, two roles: flash this on every Brainboard you want to
// drive. Each board reads its OWN config.json from the SD card root,
// which tells it which outputs to wire, how many LEDs per output, and
// which slice of the stream it owns. Patterns live as .bin files in
// /animations/; the phone web UI on http://<board-ip>/ lists them and
// lets you pick which one plays.
//
// File layout expected on the SD card (root):
//   /config.json                  see VolumeCube's "SD card" export
//   /animations/*.bin             pre-baked frame data, one per pattern
//
// .bin format (must match sdCardExport.ts):
//   bytes  0-3   magic    = 'VCAN'
//   byte   4     version  = 1
//   byte   5     reserved
//   bytes  6-7   fps                uint16 LE
//   bytes  8-11  ledCount           uint32 LE  (this board's slice)
//   bytes 12-15  frameCount         uint32 LE
//   bytes 16+    frameCount × ledCount × 3 bytes, RGB pre-shuffled.
//                memcpy straight to CRGB.
//
// Multi-board sync: the board whose config.json says boardId "A" is the
// MASTER — it hosts the network (standalone mode), serves the control
// UI, and broadcasts a UDP sync packet before every frame (file name,
// frame index, brightness, playing flag). All other boards are
// FOLLOWERS: they render the frame they're told to instead of
// free-running their own clock, so a multi-board cube stays frame-locked
// indefinitely and pattern switches land on every board in the same
// frame. Control the cube from Board A's page only.
//
// CONCURRENCY MODEL (read before editing):
//   ESPAsyncWebServer handlers run on the async_tcp FreeRTOS task, and
//   the frame pump runs on the Arduino loop task — on a DIFFERENT core.
//   So all playback state shared between them is guarded by one mutex,
//   gStateMutex: the SD file handle, the frame counters, fps, frameCount,
//   ledsInFile, the current-animation name, and the playing flag. The
//   rules:
//     • gCurrentName is a fixed char[] (NOT an Arduino String) — a String
//       reassigned on one core while .c_str() is read on the other is a
//       use-after-free. Only ever touch it under the lock.
//     • Open + fully validate a new .bin into LOCALS, then commit to the
//       globals only on success. A failed open must leave the current
//       animation playing, never half-torn.
//     • Never hold the lock across a slow op: NVS writes (deferred to the
//       loop task), FastLED.show(), and network sends all happen OUTSIDE
//       the critical section.
//     • Brightness is a self-healing volatile byte applied by the loop
//       task at the top of a frame, never written mid-show() by the web
//       or sync path.
//
// Libraries required (Arduino Library Manager):
//   • FastLED            — LED driving
//   • ArduinoJson        — config parsing
//   • ESPAsyncWebServer  — non-blocking HTTP for the phone UI
//   • AsyncTCP           — dependency of ESPAsyncWebServer
// (WiFi + WiFiUdp ship with the ESP32 core — nothing extra to install.)

#include <Arduino.h>
#include <FastLED.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <Preferences.h>

// ---- Edit these for your network --------------------------------------------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
// SD card chip-select pin for the QuinLED Dig-Octa Brainboard. Check
// the silkscreen on your specific board revision and update if needed.
const int   SD_CS_PIN     = 5;
// If your board routes the SD slot to non-default SPI pins, set all
// three here. -1 = use the ESP32 default VSPI pins (SCK 18, MISO 19,
// MOSI 23). If SD.begin() fails on first boot, this is the first
// thing to check against the quinled.info pinout.
const int   SD_SCK_PIN    = -1;
const int   SD_MISO_PIN   = -1;
const int   SD_MOSI_PIN   = -1;
// Max LEDs per output channel. Bound on the per-output buffer size we
// allocate. 600 is the QuinLED-rated max per chain.
const int   MAX_LEDS_PER_OUT = 600;
const int   MAX_OUTPUTS      = 8;
// ----------------------------------------------------------------------------

// Bin format constants — must match sdCardExport.ts BIN_*.
const uint32_t BIN_MAGIC   = 0x4E414356; // 'VCAN' little-endian
const uint8_t  BIN_VERSION = 1;
const size_t   BIN_HEADER_LEN = 16;

// Frame-sync wire protocol.
const uint16_t SYNC_PORT     = 22083;       // 0x5643 — 'VC'
const uint8_t  SYNC_VERSION  = 1;
const size_t   SYNC_MAX_NAME = 64;
const uint32_t SYNC_MAGIC    = 0x59534356;  // 'VCSY' little-endian
const size_t   SYNC_HDR      = 15;          // bytes before the name field
// A follower that WAS synced and then hears nothing for this long assumes
// the network split (e.g. it joined home WiFi but the master fell back to
// its own AP) and reboots to re-run the full join hunt. Followers that
// have never heard a master (single-board bench test) never arm this.
const uint32_t SYNC_LOST_REBOOT_MS = 60000;
// Don't write the "last played" name to NVS flash more than this often —
// bounds flash wear if something (or someone) switches patterns rapidly.
const uint32_t NVS_SAVE_MIN_INTERVAL_MS = 10000;

struct OutputCfg {
  int pin;
  uint32_t ledStart;
  uint32_t ledCount;
  String label;
};

struct BoardCfg {
  String boardId;
  String name;
  uint32_t totalLeds;
  int outputCount;
  OutputCfg outputs[MAX_OUTPUTS];
};

BoardCfg gBoard;                 // written only in setup(); read-only after
bool gIsMaster = true;

// Single contiguous CRGB buffer. Each output's addLeds<>() points at its
// slice via (leds, ledStart, ledCount). Sized to MAX so the buffer is
// stable across configurations.
CRGB gLeds[MAX_LEDS_PER_OUT * MAX_OUTPUTS];

// ---- Playback state — ALL guarded by gStateMutex ----
File     gAnimFile;
char     gCurrentName[SYNC_MAX_NAME + 1] = {0};
uint16_t gFps         = 30;
uint32_t gLedsInFile  = 0;
uint32_t gFrameCount  = 0;
uint32_t gCurrentFrame = 0;
bool     gIsPlaying   = false;
// Deferred NVS save: openAnimation sets this under the lock; the loop
// task drains it OUTSIDE the lock so a flash commit never stalls the
// frame pump or the async_tcp task.
char     gPendingSaveName[SYNC_MAX_NAME + 1] = {0};

SemaphoreHandle_t gStateMutex;

// ---- Brightness — self-healing volatile bytes, no lock needed ----
// gPendingBrightness is set by the web handler (master) or the sync
// packet (follower); the loop task copies it into gBrightness and calls
// FastLED.setBrightness at the top of a frame, never mid-show().
volatile uint8_t gBrightness        = 192;
volatile uint8_t gPendingBrightness = 192;

// ---- Loop-task-only NVS bookkeeping (no lock) ----
char          gLastSavedName[SYNC_MAX_NAME + 1] = {0};
unsigned long gLastSaveMs = 0;

unsigned long gLastFrameMs   = 0;
unsigned long gLastSyncRxMs  = 0;   // 0 = never heard a master

Preferences   gPrefs;
AsyncWebServer gServer(80);
WiFiUDP        gSyncUdp;

struct SyncMsg {
  uint32_t frame;
  uint16_t fps;
  uint8_t  brightness;
  bool     playing;
  char     name[SYNC_MAX_NAME + 1];
};

// ---------------------------------------------------------------------------
//  Forward declarations
// ---------------------------------------------------------------------------
bool loadBoardConfig();
bool openAnimation(const char* name);
static bool openAnimationLocked(const char* name);
static bool readFrameLocked();          // assumes gStateMutex held
void scanAnimations(JsonArray out);
void setupWebRoutes();
void connectWifi();
void startAccessPoint(const String& name);
bool joinNetwork(const char* ssid, const char* pass, uint32_t timeoutMs);
void masterLoop();
void followerLoop();
void processDeferredSave();
void applyPendingBrightness();
size_t buildSyncPacketLocked(uint8_t* pkt);
bool parseSyncPacket(const uint8_t* d, int len, SyncMsg& out);

static inline void lockState()   { xSemaphoreTake(gStateMutex, portMAX_DELAY); }
static inline void unlockState() { xSemaphoreGive(gStateMutex); }

// ---------------------------------------------------------------------------
//  setup()
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("VolumeCube SD-card player booting…");

  gStateMutex = xSemaphoreCreateMutex();

  // ---- SD card ----
  if (SD_SCK_PIN >= 0) {
    SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
  }
  if (!SD.begin(SD_CS_PIN)) {
    Serial.println("FATAL: SD card mount failed. Check wiring + CS pin.");
    while (true) delay(1000);
  }
  Serial.println("SD mounted.");

  // ---- Board config ----
  if (!loadBoardConfig()) {
    Serial.println("FATAL: /config.json missing or invalid.");
    while (true) delay(1000);
  }
  Serial.printf("Board %s: %d outputs, %u LEDs total\n",
                gBoard.boardId.c_str(), gBoard.outputCount,
                (unsigned)gBoard.totalLeds);
  gIsMaster = (gBoard.boardId == "A");
  Serial.printf("Sync role: %s\n",
                gIsMaster ? "MASTER — broadcasts the frame clock"
                          : "FOLLOWER — frame-locked to Board A");

  // ---- FastLED outputs from config ----
  // Each output is one addLeds<>() call pointing at its slice of the
  // shared CRGB buffer. The template's pin parameter must be a literal,
  // so we switch over the configured pin number. Covers the Dig-Octa
  // map LED1..LED8 = GPIO 0,1,2,3,4,5,12,13. Classic ESP32 has 8 RMT
  // channels, so up to 8 parallel outputs is within the hardware limit.
  for (int i = 0; i < gBoard.outputCount; i++) {
    const OutputCfg& o = gBoard.outputs[i];
    Serial.printf("  out%d: GPIO %d, %u LEDs starting at %u\n",
                  i, o.pin, (unsigned)o.ledCount, (unsigned)o.ledStart);
    switch (o.pin) {
      case 0:  FastLED.addLeds<WS2815, 0,  RGB>(gLeds, o.ledStart, o.ledCount); break;
      case 1:  FastLED.addLeds<WS2815, 1,  RGB>(gLeds, o.ledStart, o.ledCount); break;
      case 2:  FastLED.addLeds<WS2815, 2,  RGB>(gLeds, o.ledStart, o.ledCount); break;
      case 3:  FastLED.addLeds<WS2815, 3,  RGB>(gLeds, o.ledStart, o.ledCount); break;
      case 4:  FastLED.addLeds<WS2815, 4,  RGB>(gLeds, o.ledStart, o.ledCount); break;
      case 5:  FastLED.addLeds<WS2815, 5,  RGB>(gLeds, o.ledStart, o.ledCount); break;
      case 12: FastLED.addLeds<WS2815, 12, RGB>(gLeds, o.ledStart, o.ledCount); break;
      case 13: FastLED.addLeds<WS2815, 13, RGB>(gLeds, o.ledStart, o.ledCount); break;
      default:
        Serial.printf("WARN: GPIO %d not in supported list (0,1,2,3,4,5,12,13). Skipping output.\n", o.pin);
        break;
    }
  }
  FastLED.setBrightness(gBrightness);
  FastLED.clear();
  FastLED.show();

  // ---- WiFi ----
  connectWifi();
  gSyncUdp.begin(SYNC_PORT);

  // ---- Pick the last-played animation, else the first available ----
  // Runs BEFORE gServer.begin() so the boot-time directory walk can't
  // race an early /api request from a phone still polling a stale page.
  gPrefs.begin("vcplayer", false);
  String lastPlayed = gPrefs.getString("last", "");
  if (lastPlayed.length() && openAnimation(lastPlayed.c_str())) {
    strncpy(gLastSavedName, lastPlayed.c_str(), SYNC_MAX_NAME);
    Serial.printf("Resumed: %s\n", lastPlayed.c_str());
  } else {
    File anims = SD.open("/animations");
    File entry;
    while ((entry = anims.openNextFile())) {
      String n = entry.name();
      int slash = n.lastIndexOf('/');
      if (slash >= 0) n = n.substring(slash + 1);
      entry.close();
      if (n.endsWith(".bin") && openAnimation(n.c_str())) {
        Serial.printf("Auto-loaded: %s\n", n.c_str());
        break;
      }
    }
    anims.close();
  }
  // Clear any save queued by the boot open — it's already what's in NVS.
  lockState(); gPendingSaveName[0] = 0; unlockState();

  // ---- Web server (last — playback state settled) ----
  setupWebRoutes();
  gServer.begin();
  String uiIp = (WiFi.getMode() & WIFI_AP)
      ? WiFi.softAPIP().toString()
      : WiFi.localIP().toString();
  Serial.printf("Web UI: http://%s/\n", uiIp.c_str());
}

// ---------------------------------------------------------------------------
//  loop()
// ---------------------------------------------------------------------------
void loop() {
  processDeferredSave();      // outside any lock
  if (gIsMaster) masterLoop();
  else           followerLoop();
}

void masterLoop() {
  uint16_t fps;
  bool playing;
  lockState();
  fps = gFps ? gFps : 30;
  playing = gIsPlaying;
  unlockState();

  if (!playing) { delay(20); return; }

  unsigned long now = millis();
  if (now - gLastFrameMs < 1000UL / fps) { delay(1); return; }
  gLastFrameMs = now;

  applyPendingBrightness();

  // Read the frame + build the broadcast packet atomically under the lock
  // (so the name/frame/fps the packet carries match the bytes we render),
  // then increment. show() + network send happen outside the lock.
  uint8_t pkt[SYNC_HDR + SYNC_MAX_NAME];
  size_t pktLen;
  bool ok;
  lockState();
  ok = readFrameLocked();
  pktLen = buildSyncPacketLocked(pkt);
  if (ok && gFrameCount > 0) {
    gCurrentFrame++;
    if (gCurrentFrame >= gFrameCount) gCurrentFrame = 0;
  }
  unlockState();

  gSyncUdp.beginPacket(IPAddress(255, 255, 255, 255), SYNC_PORT);
  gSyncUdp.write(pkt, pktLen);
  gSyncUdp.endPacket();
  if (ok) FastLED.show();
}

void followerLoop() {
  // Drain the queue, keep only the newest valid packet — if we fell
  // behind, jumping to the latest frame beats replaying stale ones.
  SyncMsg msg;
  bool got = false;
  int avail;
  while ((avail = gSyncUdp.parsePacket()) > 0) {
    uint8_t buf[SYNC_HDR + SYNC_MAX_NAME];
    int n = gSyncUdp.read(buf, sizeof(buf));
    if (parseSyncPacket(buf, n, msg)) got = true;
  }

  unsigned long now = millis();

  if (got) {
    gLastSyncRxMs = now;
    gPendingBrightness = msg.brightness;
    // Master switched files. Try to match; on failure KEEP playing what
    // we have (openAnimation no longer tears down state on failure).
    // Per-name 5 s back-off so a missing file doesn't hammer the SD bus.
    if (msg.name[0]) {
      bool nameDiffers;
      lockState();
      nameDiffers = strncmp(msg.name, gCurrentName, SYNC_MAX_NAME) != 0;
      unlockState();
      if (nameDiffers) {
        static char failedName[SYNC_MAX_NAME + 1] = {0};
        static unsigned long failedAt = 0;
        if (strncmp(msg.name, failedName, SYNC_MAX_NAME) != 0 ||
            now - failedAt > 5000) {
          if (openAnimation(msg.name)) {
            failedName[0] = 0;
          } else {
            strncpy(failedName, msg.name, SYNC_MAX_NAME);
            failedAt = now;
          }
        }
      }
    }
  }

  // Synced-then-lost → assume a network split and reboot to re-hunt. Only
  // arms if we've EVER heard the master (gLastSyncRxMs != 0), so a
  // single-board bench follower free-runs forever instead of reboot-looping.
  if (gLastSyncRxMs != 0 && now - gLastSyncRxMs > SYNC_LOST_REBOOT_MS &&
      (WiFi.getMode() & WIFI_MODE_STA)) {
    Serial.println("Sync lost for 60 s — rebooting to re-hunt the master network.");
    delay(50);
    ESP.restart();
  }

  applyPendingBrightness();

  // Honor an explicit pause from the master (playing flag = 0): hold the
  // last rendered frame rather than free-running.
  if (got && !msg.playing) { delay(5); return; }

  uint16_t fps;
  bool playing;
  uint32_t fc;
  bool namesMatch = false;
  lockState();
  fps = gFps ? gFps : 30;
  playing = gIsPlaying;
  fc = gFrameCount;
  if (got && msg.name[0]) {
    namesMatch = strncmp(msg.name, gCurrentName, SYNC_MAX_NAME) == 0;
  }
  unlockState();

  if (!playing) { delay(20); return; }

  if (got && namesMatch && fc > 0) {
    // Frame-locked: render exactly the master's frame.
    lockState();
    gCurrentFrame = msg.frame % gFrameCount;
    bool ok = readFrameLocked();
    unlockState();
    gLastFrameMs = now;
    if (ok) FastLED.show();
  } else {
    // Either no packet (master quiet) OR the master named a file we don't
    // have (mismatch persists past the back-off). Free-run our current
    // animation at our own fps so the cube never freezes — we snap back
    // to lock the instant a matching packet arrives.
    if (now - gLastFrameMs < 1000UL / fps) { delay(1); return; }
    gLastFrameMs = now;
    lockState();
    bool ok = readFrameLocked();
    if (ok && gFrameCount > 0) {
      gCurrentFrame++;
      if (gCurrentFrame >= gFrameCount) gCurrentFrame = 0;
    }
    unlockState();
    if (ok) FastLED.show();
  }
}

void applyPendingBrightness() {
  uint8_t pb = gPendingBrightness;
  if (pb != gBrightness) {
    gBrightness = pb;
    FastLED.setBrightness(pb);
  }
}

// Drains gPendingSaveName to NVS on the loop task, debounced. Closes the
// flash-wear vector: a name only hits flash when it actually changed AND
// at most once per NVS_SAVE_MIN_INTERVAL_MS.
void processDeferredSave() {
  char pending[SYNC_MAX_NAME + 1];
  lockState();
  strncpy(pending, gPendingSaveName, sizeof(pending));
  pending[SYNC_MAX_NAME] = 0;
  gPendingSaveName[0] = 0;
  unlockState();

  if (!pending[0]) return;
  if (strncmp(pending, gLastSavedName, SYNC_MAX_NAME) == 0) return;  // unchanged

  unsigned long now = millis();
  if (gLastSaveMs != 0 && now - gLastSaveMs < NVS_SAVE_MIN_INTERVAL_MS) {
    // Too soon — re-queue (only if nothing newer was queued meanwhile).
    lockState();
    if (!gPendingSaveName[0]) {
      strncpy(gPendingSaveName, pending, SYNC_MAX_NAME);
      gPendingSaveName[SYNC_MAX_NAME] = 0;
    }
    unlockState();
    return;
  }
  gPrefs.putString("last", pending);
  strncpy(gLastSavedName, pending, sizeof(gLastSavedName));
  gLastSavedName[SYNC_MAX_NAME] = 0;
  gLastSaveMs = now;
}

// ---------------------------------------------------------------------------
//  Frame reading (assumes gStateMutex held)
// ---------------------------------------------------------------------------
static bool readFrameLocked() {
  if (!gAnimFile || gFrameCount == 0 || gLedsInFile == 0) return false;
  size_t frameBytes = (size_t)gLedsInFile * 3;
  size_t offset = BIN_HEADER_LEN + (size_t)gCurrentFrame * frameBytes;
  gAnimFile.seek(offset);
  size_t n = gAnimFile.read((uint8_t*)gLeds, frameBytes);
  return n == frameBytes;
}

// ---------------------------------------------------------------------------
//  Sync packet (build assumes gStateMutex held; parse is pure)
// ---------------------------------------------------------------------------
// Packet layout (little-endian):
//   0-3   magic 'VCSY'      4  version       5  flags (bit0 = playing)
//   6     brightness        7  reserved      8-11 frame uint32
//   12-13 fps uint16        14 name length   15+  name (no NUL on wire)
size_t buildSyncPacketLocked(uint8_t* pkt) {
  size_t nameLen = strnlen(gCurrentName, SYNC_MAX_NAME);
  pkt[0] = 0x56; pkt[1] = 0x43; pkt[2] = 0x53; pkt[3] = 0x59;
  pkt[4] = SYNC_VERSION;
  pkt[5] = gIsPlaying ? 0x01 : 0x00;
  pkt[6] = gBrightness;
  pkt[7] = 0;
  pkt[8]  = gCurrentFrame & 0xff;
  pkt[9]  = (gCurrentFrame >> 8) & 0xff;
  pkt[10] = (gCurrentFrame >> 16) & 0xff;
  pkt[11] = (gCurrentFrame >> 24) & 0xff;
  pkt[12] = gFps & 0xff;
  pkt[13] = (gFps >> 8) & 0xff;
  pkt[14] = (uint8_t)nameLen;
  memcpy(pkt + SYNC_HDR, gCurrentName, nameLen);
  return SYNC_HDR + nameLen;
}

bool parseSyncPacket(const uint8_t* d, int len, SyncMsg& out) {
  if (len < (int)SYNC_HDR) return false;
  uint32_t magic = (uint32_t)d[0] | ((uint32_t)d[1] << 8)
                 | ((uint32_t)d[2] << 16) | ((uint32_t)d[3] << 24);
  if (magic != SYNC_MAGIC || d[4] != SYNC_VERSION) return false;
  uint8_t nameLen = d[14];
  if (nameLen > SYNC_MAX_NAME || (int)(SYNC_HDR + nameLen) > len) return false;
  out.playing    = (d[5] & 0x01) != 0;
  out.brightness = d[6];
  out.frame = (uint32_t)d[8] | ((uint32_t)d[9] << 8)
            | ((uint32_t)d[10] << 16) | ((uint32_t)d[11] << 24);
  out.fps = (uint16_t)d[12] | ((uint16_t)d[13] << 8);
  memcpy(out.name, d + SYNC_HDR, nameLen);
  out.name[nameLen] = 0;
  return true;
}

// ---------------------------------------------------------------------------
//  Config + animation loading
// ---------------------------------------------------------------------------
bool loadBoardConfig() {
  File f = SD.open("/config.json");
  if (!f) return false;
  DynamicJsonDocument doc(2048);
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.printf("config.json parse error: %s\n", err.c_str());
    return false;
  }
  gBoard.boardId   = String(doc["boardId"] | "?");
  gBoard.name      = doc["name"] | gBoard.boardId;
  gBoard.totalLeds = doc["totalLeds"].as<uint32_t>();
  JsonArray outs = doc["outputs"].as<JsonArray>();
  gBoard.outputCount = 0;
  for (JsonObject o : outs) {
    if (gBoard.outputCount >= MAX_OUTPUTS) break;
    OutputCfg& cfg = gBoard.outputs[gBoard.outputCount++];
    cfg.pin      = o["pin"].as<int>();
    cfg.ledStart = o["ledStart"].as<uint32_t>();
    cfg.ledCount = o["ledCount"].as<uint32_t>();
    cfg.label    = String(o["label"] | "");
  }
  return true;
}

bool openAnimation(const char* name) {
  lockState();
  bool ok = openAnimationLocked(name);
  unlockState();
  return ok;
}

// Opens and FULLY validates the named file into locals, and commits to the
// playback globals only on success. On ANY failure the current animation
// is left untouched and still playing. Assumes gStateMutex held.
static bool openAnimationLocked(const char* name) {
  if (!name || !name[0]) return false;

  // Reject path traversal / nesting — the name comes from an unauthenticated
  // UDP packet on the follower path and a phone POST on the master.
  if (strstr(name, "..") || strchr(name, '/') || strchr(name, '\\')) {
    Serial.printf("Rejecting unsafe animation name: %s\n", name);
    return false;
  }

  // Normalize to a NUL-terminated name ending in ".bin" (this is what we
  // store + broadcast, so master/follower comparisons stay consistent).
  char norm[SYNC_MAX_NAME + 1];
  strncpy(norm, name, SYNC_MAX_NAME);
  norm[SYNC_MAX_NAME] = 0;
  size_t nlen = strlen(norm);
  if (nlen < 4 || strcmp(norm + nlen - 4, ".bin") != 0) {
    if (nlen + 4 > SYNC_MAX_NAME) return false;   // would overflow the field
    strcat(norm, ".bin");
  }

  char path[16 + SYNC_MAX_NAME + 1];
  snprintf(path, sizeof(path), "/animations/%s", norm);

  File tmp = SD.open(path, FILE_READ);
  if (!tmp) {
    Serial.printf("Open failed: %s\n", path);
    return false;            // current animation untouched
  }

  uint8_t hdr[BIN_HEADER_LEN];
  if (tmp.read(hdr, BIN_HEADER_LEN) != (int)BIN_HEADER_LEN) {
    Serial.println("Short header read.");
    tmp.close();
    return false;
  }
  uint32_t magic = (uint32_t)hdr[0] | ((uint32_t)hdr[1] << 8)
                 | ((uint32_t)hdr[2] << 16) | ((uint32_t)hdr[3] << 24);
  if (magic != BIN_MAGIC) {
    Serial.printf("Bad magic 0x%08x in %s\n", magic, norm);
    tmp.close();
    return false;
  }
  if (hdr[4] != BIN_VERSION) {
    Serial.printf("Unsupported version %u in %s\n", hdr[4], norm);
    tmp.close();
    return false;
  }

  uint16_t fps   = (uint16_t)hdr[6] | ((uint16_t)hdr[7] << 8);
  uint32_t leds  = (uint32_t)hdr[8]  | ((uint32_t)hdr[9] << 8)
                 | ((uint32_t)hdr[10] << 16) | ((uint32_t)hdr[11] << 24);
  uint32_t frames = (uint32_t)hdr[12] | ((uint32_t)hdr[13] << 8)
                  | ((uint32_t)hdr[14] << 16) | ((uint32_t)hdr[15] << 24);

  const uint32_t capacity = (uint32_t)MAX_LEDS_PER_OUT * MAX_OUTPUTS;
  if (leds == 0 || leds > capacity) {
    Serial.printf("Rejecting %s: ledCount %u out of range (1..%u)\n",
                  norm, (unsigned)leds, (unsigned)capacity);
    tmp.close();
    return false;
  }
  if (frames == 0) {
    Serial.printf("Rejecting %s: frameCount is 0\n", norm);
    tmp.close();
    return false;
  }
  if (fps == 0 || fps > 120) fps = 30;     // clamp absurd header values
  if (leds != gBoard.totalLeds) {
    Serial.printf("WARN: %s baked for %u LEDs, board drives %u "
                  "(wrong Board folder on this card?). Playing anyway.\n",
                  norm, (unsigned)leds, (unsigned)gBoard.totalLeds);
  }

  // ---- Commit: everything validated, now swap in atomically ----
  if (gAnimFile) gAnimFile.close();
  gAnimFile     = tmp;
  gFps          = fps;
  gLedsInFile   = leds;
  gFrameCount   = frames;
  gCurrentFrame = 0;
  strncpy(gCurrentName, norm, SYNC_MAX_NAME);
  gCurrentName[SYNC_MAX_NAME] = 0;
  gIsPlaying = true;
  // Queue persistence for the loop task (master only — followers are told
  // what to play, so persisting it just resumes the right thing on reboot).
  strncpy(gPendingSaveName, norm, SYNC_MAX_NAME);
  gPendingSaveName[SYNC_MAX_NAME] = 0;

  Serial.printf("Playing %s: %u frames @ %u fps, %u LEDs\n",
                norm, (unsigned)frames, (unsigned)fps, (unsigned)leds);
  return true;
}

void scanAnimations(JsonArray out) {
  lockState();
  File anims = SD.open("/animations");
  if (anims) {
    File entry;
    while ((entry = anims.openNextFile())) {
      String n = entry.name();
      int slash = n.lastIndexOf('/');
      if (slash >= 0) n = n.substring(slash + 1);
      if (n.endsWith(".bin")) out.add(n);
      entry.close();
    }
    anims.close();
  }
  unlockState();
}

// ---------------------------------------------------------------------------
//  WiFi
// ---------------------------------------------------------------------------
void startAccessPoint(const String& name) {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(name.c_str(), "volumecube");
  Serial.printf("AP: %s (pwd volumecube) — UI at http://%s/\n",
                name.c_str(), WiFi.softAPIP().toString().c_str());
}

bool joinNetwork(const char* ssid, const char* pass, uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, pass);
  Serial.printf("Joining %s", ssid);
  unsigned long start = millis();
  unsigned long lastKick = start;
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(500);
    Serial.print(".");
    if (millis() - lastKick > 10000) {   // re-kick if the AP was slow to boot
      WiFi.begin(ssid, pass);
      lastKick = millis();
    }
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Joined %s: %s\n", ssid, WiFi.localIP().toString().c_str());
    return true;
  }
  return false;
}

void connectWifi() {
  const bool haveHomeWifi =
      !(strcmp(WIFI_SSID, "YOUR_WIFI_SSID") == 0 || strlen(WIFI_SSID) == 0);

  if (gIsMaster) {
    if (haveHomeWifi && joinNetwork(WIFI_SSID, WIFI_PASSWORD, 30000)) return;
    Serial.println(haveHomeWifi
        ? "Home WiFi failed — master hosting the cube AP instead."
        : "No WiFi configured — master hosts the cube AP.");
    startAccessPoint("VolumeCube");
  } else {
    if (haveHomeWifi && joinNetwork(WIFI_SSID, WIFI_PASSWORD, 30000)) return;
    if (joinNetwork("VolumeCube", "volumecube", 45000)) return;
    Serial.println("Could not reach the master — debug AP + free-running.");
    startAccessPoint("VolumeCube-" + gBoard.boardId);
  }
}

// ---------------------------------------------------------------------------
//  Web UI
// ---------------------------------------------------------------------------
const char INDEX_HTML[] PROGMEM = R"HTML(<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VolumeCube</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 1em;
         background: #111; color: #eee; }
  h1 { font-size: 1.1em; margin: 0 0 .2em 0; opacity: .7; }
  .now { font-size: 1.4em; margin-bottom: 1em; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .9em; background: #222; margin-bottom: .3em; border-radius: 6px; cursor: pointer; }
  li.active { background: #3a4a88; }
  li.ro { cursor: default; opacity: .8; }
  .brightness { margin-top: 1.2em; display: flex; gap: .6em; align-items: center; }
  input[type=range] { flex: 1; }
  .err { color: #ff8060; margin-top: 1em; }
</style>
</head><body>
<h1 id="board">VolumeCube</h1>
<div class="now">Now: <strong id="now">…</strong></div>
<ul id="list"></ul>
<div class="brightness" id="brwrap">
  <span>Brightness</span>
  <input type="range" id="br" min="0" max="255" value="192">
  <span id="brv">192</span>
</div>
<div class="err" id="err"></div>
<script>
let isMaster = true;
async function refresh() {
  const s = await (await fetch('/api/status')).json();
  isMaster = s.role === 'master';
  document.getElementById('board').textContent = (s.board||'') + ' — ' + (s.id||'')
    + (isMaster ? '' : ' (follower — control the whole cube from Board A)');
  document.getElementById('now').textContent = s.current || '(none)';
  document.getElementById('br').value = s.brightness;
  document.getElementById('brv').textContent = s.brightness;
  document.getElementById('brwrap').style.display = isMaster ? 'flex' : 'none';
  const list = await (await fetch('/api/list')).json();
  const ul = document.getElementById('list');
  ul.innerHTML = '';
  for (const name of list) {
    const li = document.createElement('li');
    li.textContent = name.replace(/\.bin$/,'');
    if (name === s.current) li.className = 'active';
    if (!isMaster) { li.className += ' ro'; }
    else li.onclick = async () => {
      try {
        const r = await fetch('/api/play', {method:'POST', headers:{'Content-Type':'application/json'},
                                            body: JSON.stringify({name})});
        if (!r.ok) throw new Error(await r.text());
        refresh();
      } catch(e) { document.getElementById('err').textContent = String(e); }
    };
    ul.appendChild(li);
  }
}
document.getElementById('br').oninput = async (e) => {
  const v = +e.target.value;
  document.getElementById('brv').textContent = v;
  if (!isMaster) return;
  await fetch('/api/brightness', {method:'POST', headers:{'Content-Type':'application/json'},
                                  body: JSON.stringify({brightness:v})});
};
refresh();
setInterval(refresh, 5000);
</script>
</body></html>)HTML";

// Accumulate a (possibly multi-chunk) request body into req->_tempObject as
// a NUL-terminated C string. Returns true once the whole body is present.
// ESPAsyncWebServer frees _tempObject in the request destructor, so an
// aborted upload can't leak.
static bool accumulateBody(AsyncWebServerRequest* req, uint8_t* data,
                           size_t len, size_t index, size_t total) {
  if (index == 0) {
    if (req->_tempObject) { free(req->_tempObject); req->_tempObject = nullptr; }
    if (total == 0 || total > 1024) return false;
    req->_tempObject = malloc(total + 1);
  }
  if (!req->_tempObject) return false;
  memcpy((uint8_t*)req->_tempObject + index, data, len);
  if (index + len >= total) {
    ((char*)req->_tempObject)[total] = 0;
    return true;
  }
  return false;
}

void setupWebRoutes() {
  gServer.on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
    req->send_P(200, "text/html", INDEX_HTML);
  });

  gServer.on("/api/status", HTTP_GET, [](AsyncWebServerRequest* req) {
    // Snapshot the shared name under the lock into a local before building
    // JSON — never hand an Arduino String backed by gCurrentName across.
    char nameSnap[SYNC_MAX_NAME + 1];
    bool playing;
    uint16_t fps;
    lockState();
    strncpy(nameSnap, gCurrentName, sizeof(nameSnap));
    nameSnap[SYNC_MAX_NAME] = 0;
    playing = gIsPlaying;
    fps = gFps;
    unlockState();

    DynamicJsonDocument doc(384);
    doc["board"] = gBoard.name;
    doc["id"] = gBoard.boardId;
    doc["role"] = gIsMaster ? "master" : "follower";
    doc["current"] = nameSnap;
    doc["fps"] = fps;
    doc["brightness"] = gBrightness;
    doc["playing"] = playing;
    String s;
    serializeJson(doc, s);
    req->send(200, "application/json", s);
  });

  gServer.on("/api/list", HTTP_GET, [](AsyncWebServerRequest* req) {
    DynamicJsonDocument doc(4096);
    JsonArray a = doc.to<JsonArray>();
    scanAnimations(a);
    String s;
    serializeJson(doc, s);
    req->send(200, "application/json", s);
  });

  // Control endpoints live ONLY on the master — followers are driven by
  // the sync stream, so accepting play/brightness on them would just be a
  // way to desync the cube.
  if (gIsMaster) {
    // POST /api/play  { "name": "harmonic-blob.bin" }
    gServer.on("/api/play", HTTP_POST,
      [](AsyncWebServerRequest* req) {
        if (!req->_tempObject) { req->send(400, "text/plain", "empty body"); return; }
        DynamicJsonDocument doc(256);
        DeserializationError err = deserializeJson(doc, (const char*)req->_tempObject);
        free(req->_tempObject);
        req->_tempObject = nullptr;
        if (err) { req->send(400, "text/plain", err.c_str()); return; }
        const char* name = doc["name"] | "";
        if (openAnimation(name)) req->send(200, "application/json", "{\"ok\":true}");
        else                     req->send(500, "text/plain", "could not open");
      },
      nullptr,
      [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
        accumulateBody(req, data, len, index, total);
      });

    // POST /api/brightness  { "brightness": 0..255 }
    gServer.on("/api/brightness", HTTP_POST,
      [](AsyncWebServerRequest* req) {
        if (!req->_tempObject) { req->send(400, "text/plain", "empty body"); return; }
        DynamicJsonDocument doc(128);
        DeserializationError err = deserializeJson(doc, (const char*)req->_tempObject);
        free(req->_tempObject);
        req->_tempObject = nullptr;
        if (err) { req->send(400, "text/plain", "bad json"); return; }
        int b = doc["brightness"].as<int>();
        if (b < 0) b = 0;
        if (b > 255) b = 255;
        gPendingBrightness = (uint8_t)b;   // applied by the loop task
        req->send(200, "application/json", "{\"ok\":true}");
      },
      nullptr,
      [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
        accumulateBody(req, data, len, index, total);
      });
  }
}
