// VolumeCube — ESP32 serial receiver firmware.
//
// Receives RGB frames from the VolumeCube desktop app over USB serial
// and drives a WS2815 chain via FastLED.
//
// Frame format (must match src/core/transports/serial.ts on the host):
//   [0xCC][0xBE]           magic prefix — resyncs on loss
//   [len_hi][len_lo]       big-endian 16-bit payload length in bytes
//   [rgb bytes ...]        stream-ordered RGB triples (3 × LED_COUNT)
//   [crc_hi][crc_lo]       CRC-16/CCITT-FALSE over the rgb bytes
//
// The host is already applying brightness + gamma + color-order shuffle
// + wiring address map, so this firmware is intentionally dumb — just
// memcpy the payload into the FastLED buffer and call show().
//
// Hardware notes:
//   - WS2815 runs on 12 V. Common-ground the ESP32 and the PSU ground,
//     then feed DATA_PIN through a 3.3V → 5V level shifter (74AHCT125
//     or similar) before it reaches the strip's DIN line.
//   - WS2815 also has a backup data line (BI); wire strip i+1's BI to
//     strip i's DO so a single LED failure doesn't black out everything
//     downstream.

#include <FastLED.h>

// ---- User-editable config ----------------------------------------------
#define CUBE_N     10
#define LED_COUNT  (CUBE_N * CUBE_N * CUBE_N)
#define DATA_PIN   6
#define BAUD_RATE  921600
// ------------------------------------------------------------------------

#define MAGIC1      0xCC
#define MAGIC2      0xBE
#define FRAME_BYTES (LED_COUNT * 3)

CRGB leds[LED_COUNT];

enum State {
  WAIT_MAGIC1,
  WAIT_MAGIC2,
  READ_LEN_HI,
  READ_LEN_LO,
  READ_DATA,
  READ_CRC_HI,
  READ_CRC_LO,
};

static State state = WAIT_MAGIC1;
static uint16_t frameLen = 0;
static uint16_t bytesRead = 0;
static uint8_t crcHiByte = 0;
static uint16_t crcRecv = 0;
static uint8_t buf[FRAME_BYTES];

// CRC-16/CCITT-FALSE. Poly 0x1021, init 0xFFFF, no reflection, no xorout.
static uint16_t crc16Ccitt(const uint8_t *data, size_t n) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < n; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else              crc <<= 1;
    }
  }
  return crc;
}

void setup() {
  Serial.begin(BAUD_RATE);
  FastLED.addLeds<WS2815, DATA_PIN, RGB>(leds, LED_COUNT);
  FastLED.setBrightness(255);
  FastLED.clear();
  FastLED.show();
}

void loop() {
  while (Serial.available()) {
    uint8_t b = Serial.read();
    switch (state) {
      case WAIT_MAGIC1:
        if (b == MAGIC1) state = WAIT_MAGIC2;
        break;
      case WAIT_MAGIC2:
        state = (b == MAGIC2) ? READ_LEN_HI : WAIT_MAGIC1;
        break;
      case READ_LEN_HI:
        frameLen = (uint16_t)b << 8;
        state = READ_LEN_LO;
        break;
      case READ_LEN_LO:
        frameLen |= b;
        if (frameLen == 0 || frameLen > FRAME_BYTES) {
          // Malformed length — drop back to sync search.
          state = WAIT_MAGIC1;
        } else {
          bytesRead = 0;
          state = READ_DATA;
        }
        break;
      case READ_DATA:
        buf[bytesRead++] = b;
        if (bytesRead >= frameLen) state = READ_CRC_HI;
        break;
      case READ_CRC_HI:
        crcHiByte = b;
        state = READ_CRC_LO;
        break;
      case READ_CRC_LO:
        crcRecv = ((uint16_t)crcHiByte << 8) | b;
        if (crc16Ccitt(buf, frameLen) == crcRecv) {
          memcpy((uint8_t *)leds, buf, frameLen);
          FastLED.show();
        }
        // CRC mismatches silently drop the frame; the next magic
        // prefix re-syncs us.
        state = WAIT_MAGIC1;
        break;
    }
  }
}
