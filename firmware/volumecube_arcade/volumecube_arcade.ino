// VolumeCube Arcade — live, phone-controlled games on the cube.
//
// Separate from the SD pattern-player firmware (that one's near its flash
// limit, and these are different jobs). Flash THIS when you want to play;
// flash the player back for ambient patterns. Same SD card, same WiFi AP,
// same LED outputs.
//
// Games (pick on the phone at http://volumecube.local/ or 192.168.4.1):
//   • Pong  — vs Computer, or 2-player (two phones). Drag a touch-pad to
//             move your paddle on the cube's near/far face.
//   • Tetris— 1 player vs gravity. On-screen D-pad moves the piece in X/Z,
//             Rotate cycles rotation, Drop hard-drops. Full XZ layers clear.
//
// How it knows the cube's 3D shape: the desktop bake drops a tiny cube.bin
// on the SD card (magic 'VCUB') = dimensions + a voxel->LED lookup built
// from the SAME wiring config the cube was assembled with. We load it and
// render through it, so a ball at voxel (x,y,z) lights the right LED.
//
// CONCURRENCY: ESPAsyncWebServer + the WebSocket run on the async_tcp task;
// the game loop runs on the Arduino loop task (other core). All player
// input shared between them is guarded by gInputMutex.
//
// Libraries: FastLED, ArduinoJson, ESPAsyncWebServer, AsyncTCP (all from
// Library Manager); SD/SPI/WiFi/WiFiUdp/ESPmDNS ship with the ESP32 core.

#include <Arduino.h>
#include <FastLED.h>
#include <SD.h>
#include <SPI.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <ESPmDNS.h>

// ---- Network ----
const char* WIFI_SSID     = "";        // blank => standalone "VolumeCube" AP
const char* WIFI_PASSWORD = "";

// ---- microSD (QuinLED Dig-Octa Brainboard-32-8L, verified) ----
const int SD_CS_PIN = 16, SD_SCK_PIN = 14, SD_MISO_PIN = 36, SD_MOSI_PIN = 15;

const int MAX_LEDS_PER_OUT = 600;
const int MAX_OUTPUTS      = 8;

// cube.bin format constants (must match sdCardExport.ts CUBE_*).
const uint32_t CUBE_MAGIC = 0x42554356; // 'VCUB' little-endian
const uint8_t  CUBE_VERSION = 1;
const size_t   CUBE_HEADER_LEN = 16;
const uint16_t CUBE_NO_LED = 0xffff;

const uint16_t FPS = 30;

// ---------------------------------------------------------------------------
//  Board config (pin map) — same shape the player firmware reads
// ---------------------------------------------------------------------------
struct OutputCfg { int pin; uint32_t ledStart; uint32_t ledCount; };
int        gOutputCount = 0;
OutputCfg  gOutputs[MAX_OUTPUTS];
uint32_t   gTotalLeds = 0;
String     gBoardName = "Arcade";

CRGB gLeds[MAX_LEDS_PER_OUT * MAX_OUTPUTS];

// ---- Cube geometry + voxel->LED LUT (from cube.bin) ----
uint16_t gNx = 0, gNy = 0, gNz = 0;
uint32_t gVoxelCount = 0;
uint16_t* gVoxelMap = nullptr;   // logical voxel -> local LED index (or NO_LED)

// ---------------------------------------------------------------------------
//  Player input — guarded by gInputMutex
// ---------------------------------------------------------------------------
// Two player slots. Pong uses padX/padY (0..1 normalized target on the
// face). Tetris uses the action flags (consumed/cleared by the game loop).
struct PlayerInput {
  bool   connected = false;
  float  padX = 0.5f, padY = 0.5f;   // Pong paddle target (normalized)
  // Tetris one-shot actions (latched here, consumed by the game loop):
  bool   aLeft=false,aRight=false,aFwd=false,aBack=false,aRot=false,aDrop=false;
  bool   softDrop=false;             // held state
};
PlayerInput gPlayers[2];
SemaphoreHandle_t gInputMutex;

// Game selection (also guarded by gInputMutex when written from web task).
enum GameId { GAME_MENU = 0, GAME_PONG = 1, GAME_TETRIS = 2 };
volatile int gGame = GAME_MENU;
volatile int gPongMode = 0;          // 0 = vs CPU, 1 = 2-player
volatile bool gGameDirty = true;     // request (re)init of the current game

// Which WebSocket client owns each player slot (0 = free).
uint32_t gSlotClient[2] = {0, 0};

AsyncWebServer gServer(80);
AsyncWebSocket gWs("/ws");

static inline void lockIn()   { xSemaphoreTake(gInputMutex, portMAX_DELAY); }
static inline void unlockIn() { xSemaphoreGive(gInputMutex); }

// ---------------------------------------------------------------------------
//  Rendering helpers (go through the cube LUT)
// ---------------------------------------------------------------------------
static inline void clearLeds() {
  for (uint32_t i = 0; i < gTotalLeds; i++) gLeds[i] = CRGB::Black;
}
// Additive deposit into an integer voxel, clamped, via the LUT.
static inline void addVoxel(int x, int y, int z, int r, int g, int b) {
  if (x < 0 || x >= gNx || y < 0 || y >= gNy || z < 0 || z >= gNz) return;
  uint32_t L = ((uint32_t)x * gNy + y) * gNz + z;
  if (L >= gVoxelCount) return;
  uint16_t led = gVoxelMap[L];
  if (led == CUBE_NO_LED || led >= gTotalLeds) return;
  CRGB& c = gLeds[led];
  int nr = c.r + r, ng = c.g + g, nb = c.b + b;
  c.r = nr > 255 ? 255 : nr;
  c.g = ng > 255 ? 255 : ng;
  c.b = nb > 255 ? 255 : nb;
}
// Soft spherical glow (small radius) — cheap depth cue for the ball.
static void glowSphere(float cx, float cy, float cz, float radius,
                       int r, int g, int b, float brightness) {
  if (radius <= 0) return;
  int x0 = max(0, (int)floorf(cx - radius)), x1 = min((int)gNx - 1, (int)ceilf(cx + radius));
  int y0 = max(0, (int)floorf(cy - radius)), y1 = min((int)gNy - 1, (int)ceilf(cy + radius));
  int z0 = max(0, (int)floorf(cz - radius)), z1 = min((int)gNz - 1, (int)ceilf(cz + radius));
  float inv = 1.0f / radius;
  for (int x = x0; x <= x1; x++) for (int y = y0; y <= y1; y++) for (int z = z0; z <= z1; z++) {
    float dx = x - cx, dy = y - cy, dz = z - cz;
    float d = sqrtf(dx*dx + dy*dy + dz*dz) * inv;
    if (d >= 1) continue;
    float f = (1 - d) * (1 - d) * brightness;
    addVoxel(x, y, z, (int)(r*f), (int)(g*f), (int)(b*f));
  }
}

// ---------------------------------------------------------------------------
//  PONG
// ---------------------------------------------------------------------------
struct PongState {
  float bx, by, bz, vx, vy, vz;
  float p1x, p1y, p2x, p2y;     // paddle centers (voxel coords)
  int   score1, score2;
  float flash1, flash2;
} gPong;

const float PONG_SPEED = 9.0f;
const int   PONG_PSIZE = 2;       // paddle half-size
const float PONG_AISKILL = 0.75f;

void pongServe(int towards) {
  gPong.bx = gNx / 2.0f; gPong.by = gNy / 2.0f; gPong.bz = gNz / 2.0f;
  float ang = (float)random(0, 6283) / 1000.0f;
  gPong.vx = cosf(ang) * PONG_SPEED * 0.35f;
  gPong.vy = ((float)random(-500, 500) / 1000.0f) * PONG_SPEED * 0.4f;
  float rem = PONG_SPEED*PONG_SPEED - gPong.vx*gPong.vx - gPong.vy*gPong.vy;
  if (rem < 0) rem = 0;
  gPong.vz = (towards ? 1 : -1) * sqrtf(rem);
}

void pongInit() {
  gPong.p1x = gNx/2.0f; gPong.p1y = gNy/2.0f;
  gPong.p2x = gNx/2.0f; gPong.p2y = gNy/2.0f;
  gPong.score1 = gPong.score2 = 0;
  gPong.flash1 = gPong.flash2 = 0;
  pongServe(random(0,2));
}

void pongUpdate(float dt) {
  if (dt > 0.05f) dt = 0.05f;
  PongState& s = gPong;
  float decay = expf(-dt * 4.5f);
  s.flash1 *= decay; s.flash2 *= decay;

  s.bx += s.vx*dt; s.by += s.vy*dt; s.bz += s.vz*dt;
  if (s.bx < 0)        { s.bx = 0;        s.vx = fabsf(s.vx); }
  if (s.bx > gNx-1)    { s.bx = gNx-1;    s.vx = -fabsf(s.vx); }
  if (s.by < 0)        { s.by = 0;        s.vy = fabsf(s.vy); }
  if (s.by > gNy-1)    { s.by = gNy-1;    s.vy = -fabsf(s.vy); }

  float backZ = max(0, (int)gNz - 1);

  if (s.bz < 0) {
    float dx = s.bx - s.p1x, dy = s.by - s.p1y;
    if (fabsf(dx) <= PONG_PSIZE && fabsf(dy) <= PONG_PSIZE) {
      s.bz = 0; s.vz = fabsf(s.vz); s.vx += dx; s.vy += dy; s.flash1 = 1;
    } else { s.score2++; pongServe(0); return; }
  }
  if (s.bz > backZ) {
    float dx = s.bx - s.p2x, dy = s.by - s.p2y;
    if (fabsf(dx) <= PONG_PSIZE && fabsf(dy) <= PONG_PSIZE) {
      s.bz = backZ; s.vz = -fabsf(s.vz); s.vx += dx; s.vy += dy; s.flash2 = 1;
    } else { s.score1++; pongServe(1); return; }
  }

  // Renormalize to constant speed.
  float vmag = sqrtf(s.vx*s.vx + s.vy*s.vy + s.vz*s.vz);
  if (vmag > 0.001f) { float k = PONG_SPEED / vmag; s.vx*=k; s.vy*=k; s.vz*=k; }

  // --- Paddle control ---
  // Snapshot inputs.
  float p1tx, p1ty, p2tx, p2ty; bool p2human;
  lockIn();
  p1tx = gPlayers[0].padX * (gNx-1); p1ty = gPlayers[0].padY * (gNy-1);
  p2human = (gPongMode == 1) && gPlayers[1].connected;
  p2tx = gPlayers[1].padX * (gNx-1); p2ty = gPlayers[1].padY * (gNy-1);
  unlockIn();

  // Player 1 (near paddle) tracks their touch target quickly.
  float pmax = 30.0f * dt; // player paddle responsiveness (vox/sec * dt)
  auto moveTo = [&](float& px, float& py, float tx, float ty, float cap){
    float dx = tx - px, dy = ty - py, d = sqrtf(dx*dx + dy*dy);
    if (d <= cap || d < 1e-4f) { px = tx; py = ty; }
    else { px += dx/d*cap; py += dy/d*cap; }
  };
  moveTo(s.p1x, s.p1y, p1tx, p1ty, pmax);

  // Player 2: human (2P) or AI.
  if (p2human) {
    moveTo(s.p2x, s.p2y, p2tx, p2ty, pmax);
  } else {
    // AI: aim at predicted impact, speed-capped.
    float aimx = s.bx, aimy = s.by;
    if (s.vz > 1e-6f) { float tImp = (backZ - s.bz)/s.vz; aimx = s.bx + s.vx*tImp; aimy = s.by + s.vy*tImp; }
    float aicap = PONG_AISKILL * max(gNx, gNy) * dt;
    moveTo(s.p2x, s.p2y, aimx, aimy, aicap);
  }
  s.p1x = constrain(s.p1x, 0, gNx-1); s.p1y = constrain(s.p1y, 0, gNy-1);
  s.p2x = constrain(s.p2x, 0, gNx-1); s.p2y = constrain(s.p2y, 0, gNy-1);
}

void pongRender() {
  clearLeds();
  PongState& s = gPong;
  int backZ = max(0, (int)gNz - 1);
  // Paddles (near = red, far = blue), with a soft plate.
  auto plate = [&](float px, float py, int z, int r, int g, int b, float flash){
    int cxp = (int)roundf(px), cyp = (int)roundf(py);
    for (int dy=-PONG_PSIZE; dy<=PONG_PSIZE; dy++)
      for (int dx=-PONG_PSIZE; dx<=PONG_PSIZE; dx++) {
        int br = (int)(180 + 60*flash);
        addVoxel(cxp+dx, cyp+dy, z, r*br/255, g*br/255, b*br/255);
      }
  };
  plate(s.p1x, s.p1y, 0,     255, 60, 90,  s.flash1);
  plate(s.p2x, s.p2y, backZ, 60, 140, 255, s.flash2);
  // Ball: colored halo + white-hot core.
  glowSphere(s.bx, s.by, s.bz, 2.2f, 255, 210, 90, 0.7f);
  glowSphere(s.bx, s.by, s.bz, 1.0f, 255, 255, 230, 1.0f);
  addVoxel((int)roundf(s.bx),(int)roundf(s.by),(int)roundf(s.bz),255,255,245);
}

// ---------------------------------------------------------------------------
//  TETRIS — playable (you vs gravity). Pieces fall down Y; full XZ layers
//  clear. Ported piece data + collision from tetris3d.js; random placement
//  replaced with player control + game-over.
// ---------------------------------------------------------------------------
struct TetRot { int8_t b[4][3]; };
struct TetPiece { uint8_t color[3]; uint8_t numRots; TetRot rots[3]; };

const TetPiece TET_PIECES[6] = {
  // I
  {{90,200,255}, 3, {{{{0,0,0},{1,0,0},{2,0,0},{3,0,0}}},
                     {{{0,0,0},{0,0,1},{0,0,2},{0,0,3}}},
                     {{{0,0,0},{0,1,0},{0,2,0},{0,3,0}}}}},
  // O (2 rots; pad 3rd unused)
  {{255,225,60}, 2, {{{{0,0,0},{1,0,0},{0,0,1},{1,0,1}}},
                     {{{0,0,0},{0,1,0},{1,0,0},{1,1,0}}},
                     {{{0,0,0},{1,0,0},{0,0,1},{1,0,1}}}}},
  // T
  {{200,90,255}, 3, {{{{0,0,0},{1,0,0},{2,0,0},{1,0,1}}},
                     {{{0,0,0},{0,0,1},{0,0,2},{1,0,1}}},
                     {{{0,0,0},{1,0,0},{2,0,0},{1,1,0}}}}},
  // L
  {{255,140,30}, 3, {{{{0,0,0},{1,0,0},{2,0,0},{0,0,1}}},
                     {{{0,0,0},{0,0,1},{0,0,2},{1,0,0}}},
                     {{{0,0,0},{0,1,0},{0,2,0},{1,0,0}}}}},
  // S
  {{60,230,120}, 2, {{{{0,0,0},{1,0,0},{1,0,1},{2,0,1}}},
                     {{{0,0,1},{0,0,0},{1,1,0},{1,1,1}}},
                     {{{0,0,0},{1,0,0},{1,0,1},{2,0,1}}}}},
  // Tripod (3D-only)
  {{255,70,150}, 3, {{{{0,0,0},{1,0,0},{0,1,0},{0,0,1}}},
                     {{{0,0,0},{1,0,0},{0,0,1},{1,1,0}}},
                     {{{0,0,0},{0,1,0},{0,0,1},{1,1,1}}}}},
};

const float TET_FALL = 2.2f;   // base fall steps/sec
const float TET_SOFT = 16.0f;  // soft-drop steps/sec (held)
const float TET_FLASHDUR = 0.18f;

struct TetState {
  uint8_t* stack = nullptr;
  uint8_t* col = nullptr;      // ×3
  uint32_t allocVox = 0;
  int pieceIdx, rotIdx, px, py, pz;
  bool hasPiece;
  float dropAcc;
  float clearPulse;
  int   score;
  int   flashY[64]; float flashT[64]; int flashN;
} gTet;

static inline int tetIdx(int x, int y, int z) { return (x * gNy + y) * gNz + z; }

static void tetFootprint(int pi, int ri, int& mx, int& my, int& mz) {
  mx = my = mz = 0;
  for (int k=0;k<4;k++){ const int8_t* b = TET_PIECES[pi].rots[ri].b[k];
    if (b[0]>mx) mx=b[0]; if (b[1]>my) my=b[1]; if (b[2]>mz) mz=b[2]; }
}

static bool tetCollides(int ri, int px, int py, int pz) {
  for (int k=0;k<4;k++){ const int8_t* b = TET_PIECES[gTet.pieceIdx].rots[ri].b[k];
    int x=px+b[0], y=py+b[1], z=pz+b[2];
    if (x<0||x>=gNx||z<0||z>=gNz||y<0||y>=gNy) return true;
    if (gTet.stack[tetIdx(x,y,z)]) return true;
  }
  return false;
}

static void tetSpawn(bool& gameOver) {
  gTet.pieceIdx = random(0, 6);
  gTet.rotIdx = random(0, TET_PIECES[gTet.pieceIdx].numRots);
  int mx,my,mz; tetFootprint(gTet.pieceIdx, gTet.rotIdx, mx,my,mz);
  gTet.px = (gNx - 1 - mx) / 2; if (gTet.px < 0) gTet.px = 0;
  gTet.pz = (gNz - 1 - mz) / 2; if (gTet.pz < 0) gTet.pz = 0;
  gTet.py = gNy - 1 - my;        // top
  gTet.hasPiece = true;
  gameOver = tetCollides(gTet.rotIdx, gTet.px, gTet.py, gTet.pz);
}

static void tetLock() {
  const uint8_t* c = TET_PIECES[gTet.pieceIdx].color;
  for (int k=0;k<4;k++){ const int8_t* b = TET_PIECES[gTet.pieceIdx].rots[gTet.rotIdx].b[k];
    int x=gTet.px+b[0], y=gTet.py+b[1], z=gTet.pz+b[2];
    if (x<0||x>=gNx||y<0||y>=gNy||z<0||z>=gNz) continue;
    int id = tetIdx(x,y,z);
    gTet.stack[id] = 1;
    gTet.col[id*3+0]=c[0]; gTet.col[id*3+1]=c[1]; gTet.col[id*3+2]=c[2];
  }
  // Queue any newly-full XZ layers for a flash-then-collapse.
  for (int y=0;y<gNy;y++){
    bool full=true;
    for (int x=0;x<gNx && full;x++) for (int z=0;z<gNz && full;z++)
      if (!gTet.stack[tetIdx(x,y,z)]) full=false;
    if (full){ bool already=false; for(int i=0;i<gTet.flashN;i++) if(gTet.flashY[i]==y) already=true;
      if(!already && gTet.flashN<64){ gTet.flashY[gTet.flashN]=y; gTet.flashT[gTet.flashN]=1.0f; gTet.flashN++; } }
  }
}

static void tetCollapse(int y) {
  for (int yy=y; yy<gNy-1; yy++) for (int x=0;x<gNx;x++) for (int z=0;z<gNz;z++){
    int src=tetIdx(x,yy+1,z), dst=tetIdx(x,yy,z);
    gTet.stack[dst]=gTet.stack[src];
    gTet.col[dst*3+0]=gTet.col[src*3+0]; gTet.col[dst*3+1]=gTet.col[src*3+1]; gTet.col[dst*3+2]=gTet.col[src*3+2];
  }
  for (int x=0;x<gNx;x++) for (int z=0;z<gNz;z++){
    int id=tetIdx(x,gNy-1,z); gTet.stack[id]=0; gTet.col[id*3+0]=gTet.col[id*3+1]=gTet.col[id*3+2]=0;
  }
  gTet.clearPulse = 1;
  gTet.score++;
}

void tetrisInit() {
  if (gTet.allocVox != gVoxelCount) {
    if (gTet.stack) free(gTet.stack);
    if (gTet.col) free(gTet.col);
    gTet.stack = (uint8_t*)malloc(gVoxelCount);
    gTet.col   = (uint8_t*)malloc(gVoxelCount * 3);
    gTet.allocVox = gVoxelCount;
  }
  if (gTet.stack) memset(gTet.stack, 0, gVoxelCount);
  if (gTet.col)   memset(gTet.col, 0, gVoxelCount * 3);
  gTet.dropAcc = 0; gTet.clearPulse = 0; gTet.score = 0; gTet.flashN = 0;
  bool over; tetSpawn(over);
}

void tetrisUpdate(float dt) {
  if (!gTet.stack) return;
  if (dt > 0.05f) dt = 0.05f;
  if (gTet.clearPulse > 0) { gTet.clearPulse -= dt*3.2f; if (gTet.clearPulse<0) gTet.clearPulse=0; }

  // Resolve flashes → collapse.
  for (int i=gTet.flashN-1;i>=0;i--){
    gTet.flashT[i] -= dt / TET_FLASHDUR;
    if (gTet.flashT[i] <= 0){ int y=gTet.flashY[i];
      tetCollapse(y);
      gTet.flashY[i]=gTet.flashY[gTet.flashN-1]; gTet.flashT[i]=gTet.flashT[gTet.flashN-1]; gTet.flashN--;
      for (int j=0;j<gTet.flashN;j++) if (gTet.flashY[j]>y) gTet.flashY[j]--;
    }
  }

  // Snapshot + clear one-shot player actions (player 0 drives Tetris).
  bool aL,aR,aF,aB,aRot,aDrop,soft;
  lockIn();
  PlayerInput& pi = gPlayers[0];
  aL=pi.aLeft; aR=pi.aRight; aF=pi.aFwd; aB=pi.aBack; aRot=pi.aRot; aDrop=pi.aDrop; soft=pi.softDrop;
  pi.aLeft=pi.aRight=pi.aFwd=pi.aBack=pi.aRot=pi.aDrop=false;
  unlockIn();

  if (!gTet.hasPiece) return;

  if (aL && !tetCollides(gTet.rotIdx, gTet.px-1, gTet.py, gTet.pz)) gTet.px--;
  if (aR && !tetCollides(gTet.rotIdx, gTet.px+1, gTet.py, gTet.pz)) gTet.px++;
  if (aF && !tetCollides(gTet.rotIdx, gTet.px, gTet.py, gTet.pz+1)) gTet.pz++;
  if (aB && !tetCollides(gTet.rotIdx, gTet.px, gTet.py, gTet.pz-1)) gTet.pz--;
  if (aRot) { int nr=(gTet.rotIdx+1)%TET_PIECES[gTet.pieceIdx].numRots;
    if (!tetCollides(nr, gTet.px, gTet.py, gTet.pz)) gTet.rotIdx=nr; }

  bool gameOver = false;
  if (aDrop) {
    while (!tetCollides(gTet.rotIdx, gTet.px, gTet.py-1, gTet.pz)) gTet.py--;
    tetLock(); gTet.hasPiece=false; tetSpawn(gameOver);
  } else {
    gTet.dropAcc += (soft ? TET_SOFT : TET_FALL) * dt;
    int steps=0;
    while (gTet.dropAcc >= 1 && steps < 64) {
      gTet.dropAcc -= 1; steps++;
      if (tetCollides(gTet.rotIdx, gTet.px, gTet.py-1, gTet.pz)) {
        tetLock(); gTet.hasPiece=false; tetSpawn(gameOver); break;
      }
      gTet.py--;
    }
  }
  if (gameOver) {
    // Board full → brief celebratory wash, then restart.
    gTet.clearPulse = 1;
    tetrisInit();
  }
}

void tetrisRender() {
  clearLeds();
  if (!gTet.stack) return;
  // Locked stack.
  for (int x=0;x<gNx;x++) for (int y=0;y<gNy;y++) for (int z=0;z<gNz;z++){
    int id=tetIdx(x,y,z); if (!gTet.stack[id]) continue;
    addVoxel(x,y,z, gTet.col[id*3+0]*4/5, gTet.col[id*3+1]*4/5, gTet.col[id*3+2]*4/5);
  }
  // Landing ghost (dim) + active piece (bright core + bloom).
  if (gTet.hasPiece) {
    const uint8_t* c = TET_PIECES[gTet.pieceIdx].color;
    int gy = gTet.py;
    while (gy>0 && !tetCollides(gTet.rotIdx, gTet.px, gy-1, gTet.pz)) gy--;
    for (int k=0;k<4;k++){ const int8_t* b=TET_PIECES[gTet.pieceIdx].rots[gTet.rotIdx].b[k];
      int gx=gTet.px+b[0], gyy=gy+b[1], gz=gTet.pz+b[2];
      if (gyy < gTet.py + b[1]) addVoxel(gx,gyy,gz, c[0]/6, c[1]/6, c[2]/6);
    }
    for (int k=0;k<4;k++){ const int8_t* b=TET_PIECES[gTet.pieceIdx].rots[gTet.rotIdx].b[k];
      int x=gTet.px+b[0], y=gTet.py+b[1], z=gTet.pz+b[2];
      addVoxel(x,y,z, c[0], c[1], c[2]);
      addVoxel(x+1,y,z, c[0]/4,c[1]/4,c[2]/4); addVoxel(x-1,y,z, c[0]/4,c[1]/4,c[2]/4);
      addVoxel(x,y+1,z, c[0]/4,c[1]/4,c[2]/4); addVoxel(x,y-1,z, c[0]/4,c[1]/4,c[2]/4);
      addVoxel(x,y,z+1, c[0]/4,c[1]/4,c[2]/4); addVoxel(x,y,z-1, c[0]/4,c[1]/4,c[2]/4);
    }
  }
  // Layer-clear flashes (white-hot).
  for (int i=0;i<gTet.flashN;i++){ float k=gTet.flashT[i]; if(k<0)k=0; if(k>1)k=1;
    int v=(int)(90 + 165*k*k);
    for (int x=0;x<gNx;x++) for (int z=0;z<gNz;z++) addVoxel(x,gTet.flashY[i],z, v,v,v);
  }
  // Volume wash on a clear.
  if (gTet.clearPulse>0){ int add=(int)(60*gTet.clearPulse);
    for (int x=0;x<gNx;x++) for (int y=0;y<gNy;y++) for (int z=0;z<gNz;z++) addVoxel(x,y,z, add, add*9/10, add*4/5);
  }
}

// ---------------------------------------------------------------------------
//  Menu render (no game selected)
// ---------------------------------------------------------------------------
void menuRender() {
  clearLeds();
  static float t = 0; t += 0.04f;
  // Slow rainbow sweep up the cube so it's alive while you pick a game.
  for (int y=0;y<gNy;y++) {
    float h = (float)y / max(1,(int)gNy-1) + t*0.1f;
    CHSV hsv((uint8_t)(h*255), 220, 90);
    CRGB c; hsv2rgb_rainbow(hsv, c);
    for (int x=0;x<gNx;x++) for (int z=0;z<gNz;z++)
      if ((x+y+z) % 3 == 0) addVoxel(x,y,z,c.r,c.g,c.b);
  }
}

// ---------------------------------------------------------------------------
//  cube.bin + config loading
// ---------------------------------------------------------------------------
bool loadBoardConfig() {
  File f = SD.open("/config.json");
  if (!f) return false;
  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, f)) { f.close(); return false; }
  f.close();
  gBoardName = String(doc["name"] | "Arcade");
  gTotalLeds = doc["totalLeds"].as<uint32_t>();
  JsonArray outs = doc["outputs"].as<JsonArray>();
  gOutputCount = 0;
  for (JsonObject o : outs) {
    if (gOutputCount >= MAX_OUTPUTS) break;
    gOutputs[gOutputCount].pin = o["pin"].as<int>();
    gOutputs[gOutputCount].ledStart = o["ledStart"].as<uint32_t>();
    gOutputs[gOutputCount].ledCount = o["ledCount"].as<uint32_t>();
    gOutputCount++;
  }
  return true;
}

bool loadCubeMap() {
  File f = SD.open("/cube.bin");
  if (!f) { Serial.println("cube.bin missing — re-bake the SD card."); return false; }
  uint8_t h[CUBE_HEADER_LEN];
  if (f.read(h, CUBE_HEADER_LEN) != (int)CUBE_HEADER_LEN) { f.close(); return false; }
  uint32_t magic = (uint32_t)h[0] | ((uint32_t)h[1]<<8) | ((uint32_t)h[2]<<16) | ((uint32_t)h[3]<<24);
  if (magic != CUBE_MAGIC || h[4] != CUBE_VERSION) { Serial.println("cube.bin bad magic/version"); f.close(); return false; }
  gNx = h[6] | (h[7]<<8); gNy = h[8] | (h[9]<<8); gNz = h[10] | (h[11]<<8);
  gVoxelCount = (uint32_t)h[12] | ((uint32_t)h[13]<<8) | ((uint32_t)h[14]<<16) | ((uint32_t)h[15]<<24);
  if (gVoxelCount == 0 || gVoxelCount > 200000) { f.close(); return false; }
  gVoxelMap = (uint16_t*)malloc(gVoxelCount * sizeof(uint16_t));
  if (!gVoxelMap) { Serial.println("cube.bin: out of memory"); f.close(); return false; }
  size_t want = gVoxelCount * 2;
  size_t got = f.read((uint8_t*)gVoxelMap, want);
  f.close();
  if (got != want) { Serial.println("cube.bin short read"); return false; }
  Serial.printf("cube.bin: %ux%ux%u (%u voxels)\n", gNx, gNy, gNz, (unsigned)gVoxelCount);
  return true;
}

// ---------------------------------------------------------------------------
//  WiFi
// ---------------------------------------------------------------------------
void connectWifi() {
  bool haveWifi = !(strlen(WIFI_SSID) == 0);
  if (haveWifi) {
    WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis()-start < 20000) { delay(400); Serial.print("."); }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) { Serial.printf("WiFi: %s\n", WiFi.localIP().toString().c_str()); return; }
  }
  WiFi.mode(WIFI_AP);
  WiFi.softAP("VolumeCube", "volumecube");
  Serial.printf("AP: VolumeCube (pwd volumecube) http://%s/\n", WiFi.softAPIP().toString().c_str());
}

// ---------------------------------------------------------------------------
//  WebSocket — receives player input on the async_tcp task
// ---------------------------------------------------------------------------
void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client,
               AwsEventType type, void* arg, uint8_t* data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    int slot = -1;
    lockIn();
    if (gSlotClient[0] == 0)      { slot = 0; }
    else if (gSlotClient[1] == 0) { slot = 1; }
    if (slot >= 0) {
      gSlotClient[slot] = client->id();
      gPlayers[slot].connected = true;
      gPlayers[slot].padX = 0.5f; gPlayers[slot].padY = 0.5f;
    }
    unlockIn();
    client->printf("{\"player\":%d}", slot);
    return;
  }
  if (type == WS_EVT_DISCONNECT) {
    lockIn();
    for (int i = 0; i < 2; i++) {
      if (gSlotClient[i] == client->id()) { gSlotClient[i] = 0; gPlayers[i].connected = false; }
    }
    unlockIn();
    return;
  }
  if (type != WS_EVT_DATA) return;
  DynamicJsonDocument doc(256);
  if (deserializeJson(doc, data, len)) return;
  const char* t = doc["t"] | "";
  int player = doc["p"] | 0;
  if (player < 0 || player > 1) return;

  lockIn();
  if (strcmp(t, "game") == 0) {
    const char* g = doc["g"] | "menu";
    if (strcmp(g, "pong") == 0) gGame = GAME_PONG;
    else if (strcmp(g, "tetris") == 0) gGame = GAME_TETRIS;
    else gGame = GAME_MENU;
    gPongMode = (strcmp(doc["mode"] | "cpu", "2p") == 0) ? 1 : 0;
    gGameDirty = true;
  } else if (strcmp(t, "pad") == 0) {
    gPlayers[player].padX = constrain((float)(doc["x"] | 0.5), 0.0f, 1.0f);
    gPlayers[player].padY = constrain((float)(doc["y"] | 0.5), 0.0f, 1.0f);
  } else if (strcmp(t, "act") == 0) {
    const char* a = doc["a"] | "";
    PlayerInput& pi = gPlayers[player];
    if (!strcmp(a,"left")) pi.aLeft = true;
    else if (!strcmp(a,"right")) pi.aRight = true;
    else if (!strcmp(a,"fwd")) pi.aFwd = true;
    else if (!strcmp(a,"back")) pi.aBack = true;
    else if (!strcmp(a,"rot")) pi.aRot = true;
    else if (!strcmp(a,"drop")) pi.aDrop = true;
    else if (!strcmp(a,"soft")) pi.softDrop = (bool)(doc["v"] | true);
  }
  unlockIn();
}

// ---------------------------------------------------------------------------
//  Web page (menu + adaptive controls). Served from PROGMEM.
// ---------------------------------------------------------------------------
const char INDEX_HTML[] PROGMEM = R"HTML(<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>VolumeCube Arcade</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#0a0a12;color:#eee;
 height:100vh;display:flex;flex-direction:column;overflow:hidden;touch-action:none}
h1{font-size:1.1em;text-align:center;margin:.5em 0;opacity:.8}
.menu{flex:1;display:flex;flex-direction:column;gap:.6em;padding:1em;justify-content:center}
button{font-size:1.1em;padding:1em;border-radius:10px;border:1px solid #335;
 background:#1a1a2e;color:#eee}
button:active{background:#3a4a88}
#pad{flex:1;margin:1em;border:2px solid #335;border-radius:14px;
 background:radial-gradient(circle at 50% 50%,#1a1a2e,#0a0a12);touch-action:none;
 display:flex;align-items:center;justify-content:center;color:#557}
.dpad{display:grid;grid-template-columns:repeat(3,1fr);gap:.5em;padding:1em}
.dpad button{aspect-ratio:1}
.row{display:flex;gap:.5em;padding:0 1em 1em}
.row button{flex:1}
.hidden{display:none}
#status{text-align:center;padding:.4em;opacity:.7;font-size:.9em}
</style></head><body>
<h1>VolumeCube Arcade</h1>
<div id="status">connecting…</div>
<div id="menu" class="menu">
  <button onclick="pick('pong','cpu')">🏓 Pong — vs Computer</button>
  <button onclick="pick('pong','2p')">🏓 Pong — 2 Players</button>
  <button onclick="pick('tetris','')">🟦 Tetris</button>
</div>
<div id="pongctl" class="hidden" style="flex:1;display:flex;flex-direction:column">
  <div id="pad">drag to move your paddle</div>
  <div class="row"><button onclick="menu()">⬅ Menu</button></div>
</div>
<div id="tetctl" class="hidden" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end">
  <div class="dpad">
    <span></span><button ontouchstart="act('fwd')">▲</button><span></span>
    <button ontouchstart="act('left')">◀</button>
    <button ontouchstart="act('rot')">⟳</button>
    <button ontouchstart="act('right')">▶</button>
    <span></span><button ontouchstart="act('back')">▼</button><span></span>
  </div>
  <div class="row">
    <button ontouchstart="act('drop')">⤓ Drop</button>
    <button onclick="menu()">⬅ Menu</button>
  </div>
</div>
<script>
let ws, me=0;
function connect(){
  ws=new WebSocket('ws://'+location.host+'/ws');
  ws.onopen=()=>{document.getElementById('status').textContent='connected'};
  ws.onclose=()=>{document.getElementById('status').textContent='disconnected — retrying';setTimeout(connect,1000)};
  ws.onmessage=e=>{try{const m=JSON.parse(e.data);if('player'in m){me=m.player;
    document.getElementById('status').textContent=me<0?'cube full (spectating)':'you are player '+(me+1);}}catch(_){}};
}
connect();
function send(o){o.p=me;if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
function show(id){for(const x of ['menu','pongctl','tetctl'])document.getElementById(x).classList.add('hidden');document.getElementById(id).classList.remove('hidden');}
function pick(g,mode){send({t:'game',g:g,mode:mode});show(g==='pong'?'pongctl':'tetctl');}
function menu(){send({t:'game',g:'menu'});show('menu');}
function act(a){send({t:'act',a:a});}
// Pong drag-pad
const pad=document.getElementById('pad');
function pos(e){const r=pad.getBoundingClientRect();const tx=(e.touches?e.touches[0]:e);
  let x=(tx.clientX-r.left)/r.width, y=(tx.clientY-r.top)/r.height;
  x=Math.max(0,Math.min(1,x));y=Math.max(0,Math.min(1,y));
  send({t:'pad',x:x,y:1-y});}
pad.addEventListener('touchmove',e=>{e.preventDefault();pos(e)},{passive:false});
pad.addEventListener('touchstart',e=>{e.preventDefault();pos(e)},{passive:false});
pad.addEventListener('mousemove',e=>{if(e.buttons)pos(e)});
</script></body></html>)HTML";

void setupWebRoutes() {
  gWs.onEvent(onWsEvent);
  gServer.addHandler(&gWs);
  gServer.on("/", HTTP_GET, [](AsyncWebServerRequest* req){
    AsyncWebServerResponse* res = req->beginResponse_P(200, "text/html", INDEX_HTML);
    res->addHeader("Cache-Control", "no-store");  // never serve an offline copy
    req->send(res);
  });
}

// ---------------------------------------------------------------------------
//  setup / loop
// ---------------------------------------------------------------------------
unsigned long gLastFrame = 0;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nVolumeCube Arcade booting…");
  gInputMutex = xSemaphoreCreateMutex();
  randomSeed(esp_random());

  SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
  bool sdOk = false;
  for (int i=0;i<4 && !sdOk;i++){ if (SD.begin(SD_CS_PIN)) sdOk=true; else delay(250); }
  if (!sdOk) { Serial.println("FATAL: SD mount failed."); while(true) delay(1000); }
  if (!loadBoardConfig()) { Serial.println("FATAL: config.json bad."); while(true) delay(1000); }
  if (!loadCubeMap())     { Serial.println("FATAL: cube.bin bad/missing."); while(true) delay(1000); }
  Serial.printf("Board %s: %d outputs, %u LEDs\n", gBoardName.c_str(), gOutputCount, (unsigned)gTotalLeds);

  for (int i=0;i<gOutputCount;i++){
    const OutputCfg& o = gOutputs[i];
    switch (o.pin) {
      case 0:  FastLED.addLeds<WS2815,0, RGB>(gLeds,o.ledStart,o.ledCount); break;
      case 1:  FastLED.addLeds<WS2815,1, RGB>(gLeds,o.ledStart,o.ledCount); break;
      case 2:  FastLED.addLeds<WS2815,2, RGB>(gLeds,o.ledStart,o.ledCount); break;
      case 3:  FastLED.addLeds<WS2815,3, RGB>(gLeds,o.ledStart,o.ledCount); break;
      case 4:  FastLED.addLeds<WS2815,4, RGB>(gLeds,o.ledStart,o.ledCount); break;
      case 5:  FastLED.addLeds<WS2815,5, RGB>(gLeds,o.ledStart,o.ledCount); break;
      case 12: FastLED.addLeds<WS2815,12,RGB>(gLeds,o.ledStart,o.ledCount); break;
      case 13: FastLED.addLeds<WS2815,13,RGB>(gLeds,o.ledStart,o.ledCount); break;
      default: Serial.printf("WARN: GPIO %d unsupported\n", o.pin); break;
    }
  }
  FastLED.setBrightness(180);
  FastLED.clear(); FastLED.show();

  connectWifi();
  if (MDNS.begin("volumecube")) { MDNS.addService("http","tcp",80); Serial.println("mDNS: http://volumecube.local/"); }
  setupWebRoutes();
  gServer.begin();
  Serial.println("Arcade ready. Open the page and pick a game.");
}

void loop() {
  unsigned long now = millis();
  if (now - gLastFrame < 1000UL / FPS) { delay(1); return; }
  float dt = (now - gLastFrame) / 1000.0f;
  gLastFrame = now;

  gWs.cleanupClients();

  int game = gGame;
  if (gGameDirty) {
    gGameDirty = false;
    if (game == GAME_PONG) pongInit();
    else if (game == GAME_TETRIS) tetrisInit();
  }

  switch (game) {
    case GAME_PONG:   pongUpdate(dt); pongRender();   break;
    case GAME_TETRIS: tetrisUpdate(dt); tetrisRender(); break;
    default:          menuRender();                   break;
  }
  FastLED.show();
}
