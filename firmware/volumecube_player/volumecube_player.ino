// VolumeCube SD-card player firmware.
//
// One sketch, two roles: flash this on every Brainboard you want to
// drive. Each board reads its OWN config.json from the SD card root,
// which tells it which outputs to wire, how many LEDs per output, and
// which slice of the stream it owns. Patterns live as .bin files in
// /animations/; the phone-web-UI on http://<board-ip>/ lists them and
// lets you pick which one plays.
//
// File layout expected on the SD card (root):
//   /config.json                  see VolumeCube's "SD card" export
//   /animations/*.bin             pre-baked frame data, one per pattern
//   /state.json                   last-played pattern (firmware writes this)
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
// Libraries required (Arduino Library Manager):
//   • FastLED            — LED driving
//   • ArduinoJson        — config + state parsing
//   • ESPAsyncWebServer  — non-blocking HTTP for the phone UI
//   • AsyncTCP           — dependency of ESPAsyncWebServer

#include <Arduino.h>
#include <FastLED.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
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

BoardCfg gBoard;

// Single contiguous CRGB buffer. Each output's addLeds<>() points at its
// slice via (leds, ledStart, ledCount). Sized to MAX so the buffer is
// stable across configurations.
CRGB gLeds[MAX_LEDS_PER_OUT * MAX_OUTPUTS];

// ---- Animation playback state ----
File gAnimFile;
String gCurrentName = "";
uint16_t gFps = 30;
uint32_t gLedsInFile = 0;
uint32_t gFrameCount = 0;
uint32_t gCurrentFrame = 0;
uint8_t gBrightness = 192;
bool gIsPlaying = false;
unsigned long gLastFrameMs = 0;

Preferences gPrefs;
AsyncWebServer gServer(80);

// SD bus guard. ESPAsyncWebServer handlers run on the async_tcp
// FreeRTOS task, NOT the Arduino loop task — so /api/play (which
// closes + reopens gAnimFile) and /api/list (which walks the SD
// directory) can otherwise collide with renderFrame()'s SD read
// mid-frame. Every SD touch after setup() takes this mutex.
SemaphoreHandle_t gSdMutex;

// ---------------------------------------------------------------------------
//  Forward declarations
// ---------------------------------------------------------------------------
bool loadBoardConfig();
bool openAnimation(const String& name);
static bool openAnimationLocked(const String& name);
void renderFrame();
void scanAnimations(JsonArray out);
void setupWebRoutes();
void connectWifi();

// ---------------------------------------------------------------------------
//  setup()
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("VolumeCube SD-card player booting…");

  // ---- SD card ----
  gSdMutex = xSemaphoreCreateMutex();
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
                gBoard.boardId.c_str(),
                gBoard.outputCount,
                (unsigned)gBoard.totalLeds);

  // ---- FastLED outputs from config ----
  // Each output is one addLeds<>() call pointing at its slice of the
  // shared CRGB buffer. The template's pin parameter must be a literal,
  // so we switch over the configured pin number — ugly but it's the only
  // way to convert runtime int → compile-time template argument with
  // FastLED's existing macros. Covers Q1..Q8 = GPIO 0..5, 12, 13.
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

  // ---- Pick the last-played animation or the first available ----
  // Runs BEFORE gServer.begin() so the boot-time directory walk (which
  // doesn't take gSdMutex — it would deadlock on the openAnimation call
  // inside the loop) can't collide with an early /api request from a
  // phone that still has the page open and polling.
  gPrefs.begin("vcplayer", false);
  String lastPlayed = gPrefs.getString("last", "");
  if (lastPlayed.length() && openAnimation(lastPlayed)) {
    Serial.printf("Resumed: %s\n", lastPlayed.c_str());
  } else {
    File anims = SD.open("/animations");
    File entry;
    while ((entry = anims.openNextFile())) {
      String n = entry.name();
      if (n.endsWith(".bin")) {
        // entry.name() can return just basename or full path depending
        // on SD lib version; normalize to basename.
        int slash = n.lastIndexOf('/');
        if (slash >= 0) n = n.substring(slash + 1);
        if (openAnimation(n)) {
          Serial.printf("Auto-loaded: %s\n", n.c_str());
          break;
        }
      }
      entry.close();
    }
    anims.close();
  }

  // ---- Web server (last — all playback state settled) ----
  setupWebRoutes();
  gServer.begin();
  Serial.printf("Web UI: http://%s/\n", WiFi.localIP().toString().c_str());
}

// ---------------------------------------------------------------------------
//  loop() — frame pump
// ---------------------------------------------------------------------------
void loop() {
  if (!gIsPlaying) {
    delay(20);
    return;
  }
  unsigned long now = millis();
  unsigned long interval = 1000UL / gFps;
  if (now - gLastFrameMs < interval) return;
  gLastFrameMs = now;
  renderFrame();
}

void renderFrame() {
  // SD access under the mutex; FastLED.show() outside it — show() is
  // the slow half of the frame and never touches the SD bus.
  xSemaphoreTake(gSdMutex, portMAX_DELAY);
  if (!gAnimFile) {
    xSemaphoreGive(gSdMutex);
    return;
  }
  size_t frameBytes = (size_t)gLedsInFile * 3;
  // Seek explicitly so we tolerate the firmware re-entering renderFrame
  // mid-file after a pattern switch.
  size_t offset = BIN_HEADER_LEN + (size_t)gCurrentFrame * frameBytes;
  gAnimFile.seek(offset);
  // Read straight into CRGB memory (== contiguous RGB byte buffer).
  size_t read = gAnimFile.read((uint8_t*)gLeds, frameBytes);
  xSemaphoreGive(gSdMutex);
  if (read != frameBytes) {
    Serial.printf("Short read at frame %u (got %u/%u). Looping.\n",
                  gCurrentFrame, (unsigned)read, (unsigned)frameBytes);
    gCurrentFrame = 0;
    return;
  }
  FastLED.show();
  gCurrentFrame++;
  if (gCurrentFrame >= gFrameCount) gCurrentFrame = 0;
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
  gBoard.boardId   = String((const char*)doc["boardId"] | "?");
  gBoard.name      = String((const char*)doc["name"] | gBoard.boardId);
  gBoard.totalLeds = doc["totalLeds"].as<uint32_t>();
  JsonArray outs = doc["outputs"].as<JsonArray>();
  gBoard.outputCount = 0;
  for (JsonObject o : outs) {
    if (gBoard.outputCount >= MAX_OUTPUTS) break;
    OutputCfg& cfg = gBoard.outputs[gBoard.outputCount++];
    cfg.pin      = o["pin"].as<int>();
    cfg.ledStart = o["ledStart"].as<uint32_t>();
    cfg.ledCount = o["ledCount"].as<uint32_t>();
    cfg.label    = String((const char*)o["label"] | "");
  }
  return true;
}

bool openAnimation(const String& name) {
  // Callable from both the loop task (boot autoload) and the web task
  // (/api/play) — the locked body swaps gAnimFile, so it must never
  // run concurrently with renderFrame's read.
  xSemaphoreTake(gSdMutex, portMAX_DELAY);
  bool ok = openAnimationLocked(name);
  xSemaphoreGive(gSdMutex);
  return ok;
}

static bool openAnimationLocked(const String& name) {
  String path = "/animations/" + name;
  if (!path.endsWith(".bin")) path += ".bin";
  if (gAnimFile) gAnimFile.close();
  gAnimFile = SD.open(path, FILE_READ);
  if (!gAnimFile) {
    Serial.printf("Open failed: %s\n", path.c_str());
    return false;
  }
  // Parse + validate header.
  uint8_t hdr[BIN_HEADER_LEN];
  if (gAnimFile.read(hdr, BIN_HEADER_LEN) != (int)BIN_HEADER_LEN) {
    Serial.println("Short header read.");
    gAnimFile.close();
    return false;
  }
  uint32_t magic = (uint32_t)hdr[0] | ((uint32_t)hdr[1] << 8)
                 | ((uint32_t)hdr[2] << 16) | ((uint32_t)hdr[3] << 24);
  if (magic != BIN_MAGIC) {
    Serial.printf("Bad magic 0x%08x (expected 0x%08x)\n", magic, BIN_MAGIC);
    gAnimFile.close();
    return false;
  }
  if (hdr[4] != BIN_VERSION) {
    Serial.printf("Unsupported version %u\n", hdr[4]);
    gAnimFile.close();
    return false;
  }
  gFps         = (uint16_t)hdr[6] | ((uint16_t)hdr[7] << 8);
  gLedsInFile  = (uint32_t)hdr[8]  | ((uint32_t)hdr[9] << 8)
              | ((uint32_t)hdr[10] << 16) | ((uint32_t)hdr[11] << 24);
  gFrameCount  = (uint32_t)hdr[12] | ((uint32_t)hdr[13] << 8)
              | ((uint32_t)hdr[14] << 16) | ((uint32_t)hdr[15] << 24);
  // Bounds: a corrupt or wrong-board file must never read past the
  // CRGB buffer. Reject outright rather than clamping — a clamped
  // playback would look subtly wrong and waste debugging time.
  const uint32_t capacity = (uint32_t)MAX_LEDS_PER_OUT * MAX_OUTPUTS;
  if (gLedsInFile == 0 || gLedsInFile > capacity) {
    Serial.printf("Rejecting %s: ledCount %u exceeds buffer capacity %u\n",
                  name.c_str(), (unsigned)gLedsInFile, (unsigned)capacity);
    gAnimFile.close();
    return false;
  }
  if (gLedsInFile != gBoard.totalLeds) {
    Serial.printf("WARN: %s was baked for %u LEDs but this board drives %u "
                  "(wrong Board folder on this SD card?). Playing anyway.\n",
                  name.c_str(), (unsigned)gLedsInFile, (unsigned)gBoard.totalLeds);
  }
  // Guard the loop()'s 1000/gFps against a zero or absurd header value.
  if (gFps == 0 || gFps > 120) gFps = 30;
  gCurrentFrame = 0;
  gCurrentName = name;
  gIsPlaying = true;
  gPrefs.putString("last", name);
  Serial.printf("Playing %s: %u frames @ %u fps, %u LEDs\n",
                name.c_str(), (unsigned)gFrameCount, (unsigned)gFps, (unsigned)gLedsInFile);
  return true;
}

void scanAnimations(JsonArray out) {
  // Runs on the web task — must not collide with renderFrame's SD read.
  xSemaphoreTake(gSdMutex, portMAX_DELAY);
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
  xSemaphoreGive(gSdMutex);
}

// ---------------------------------------------------------------------------
//  WiFi + Web server
// ---------------------------------------------------------------------------
void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to %s", WIFI_SSID);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 30000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWiFi failed — starting AP for setup.");
    WiFi.mode(WIFI_AP);
    String ap = "VolumeCube-" + gBoard.boardId;
    WiFi.softAP(ap.c_str(), "volumecube");
    Serial.printf("AP: %s (pwd volumecube)\n", ap.c_str());
  } else {
    Serial.printf("\nWiFi connected: %s\n", WiFi.localIP().toString().c_str());
  }
}

// Embedded minimal phone-friendly UI. Lists patterns, lets the user
// pick one, shows the currently playing pattern.
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
  li { padding: .9em; background: #222; margin-bottom: .3em; border-radius: 6px;
       cursor: pointer; }
  li.active { background: #3a4a88; }
  .brightness { margin-top: 1.2em; display: flex; gap: .6em; align-items: center; }
  input[type=range] { flex: 1; }
  .err { color: #ff8060; margin-top: 1em; }
</style>
</head><body>
<h1 id="board">VolumeCube</h1>
<div class="now">Now: <strong id="now">…</strong></div>
<ul id="list"></ul>
<div class="brightness">
  <span>Brightness</span>
  <input type="range" id="br" min="0" max="255" value="192">
  <span id="brv">192</span>
</div>
<div class="err" id="err"></div>
<script>
async function refresh() {
  const r = await fetch('/api/status');
  const s = await r.json();
  document.getElementById('board').textContent = (s.board||'') + ' — ' + (s.id||'');
  document.getElementById('now').textContent = s.current || '(none)';
  document.getElementById('br').value = s.brightness;
  document.getElementById('brv').textContent = s.brightness;
  const list = await (await fetch('/api/list')).json();
  const ul = document.getElementById('list');
  ul.innerHTML = '';
  for (const name of list) {
    const li = document.createElement('li');
    li.textContent = name.replace(/\.bin$/,'');
    if (name === s.current) li.className = 'active';
    li.onclick = async () => {
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
  await fetch('/api/brightness', {method:'POST', headers:{'Content-Type':'application/json'},
                                  body: JSON.stringify({brightness:v})});
};
refresh();
setInterval(refresh, 5000);
</script>
</body></html>)HTML";

void setupWebRoutes() {
  gServer.on("/", HTTP_GET, [](AsyncWebServerRequest* req) {
    req->send_P(200, "text/html", INDEX_HTML);
  });

  gServer.on("/api/status", HTTP_GET, [](AsyncWebServerRequest* req) {
    DynamicJsonDocument doc(512);
    doc["board"] = gBoard.name;
    doc["id"] = gBoard.boardId;
    doc["current"] = gCurrentName;
    doc["fps"] = gFps;
    doc["brightness"] = gBrightness;
    doc["playing"] = gIsPlaying;
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

  // POST /api/play  { "name": "harmonic-blob.bin" }
  gServer.on("/api/play", HTTP_POST,
    [](AsyncWebServerRequest* req) { /* handled in body callback */ },
    nullptr,
    [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
      DynamicJsonDocument doc(256);
      DeserializationError err = deserializeJson(doc, data, len);
      if (err) { req->send(400, "text/plain", err.c_str()); return; }
      String name = String((const char*)doc["name"] | "");
      if (openAnimation(name)) {
        req->send(200, "application/json", "{\"ok\":true}");
      } else {
        req->send(500, "text/plain", "could not open");
      }
    });

  // POST /api/brightness  { "brightness": 0..255 }
  gServer.on("/api/brightness", HTTP_POST,
    [](AsyncWebServerRequest* req) {},
    nullptr,
    [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
      DynamicJsonDocument doc(128);
      if (deserializeJson(doc, data, len)) { req->send(400, "text/plain", "bad json"); return; }
      int b = doc["brightness"].as<int>();
      if (b < 0) b = 0; if (b > 255) b = 255;
      gBrightness = (uint8_t)b;
      FastLED.setBrightness(gBrightness);
      req->send(200, "application/json", "{\"ok\":true}");
    });
}
