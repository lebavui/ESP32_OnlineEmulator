/*
 * Development boards that can be shown on the breadboard.
 *
 * Each board provides:
 *   name, short          display names
 *   w, h                 size in world units; header pins sit at x = lx (left) / rx (right),
 *                        y = y0 + i * pitch
 *   left, right          header pins top to bottom: GPIO numbers as strings, or 'GND' / '3V3' / '5V' / 'RST'
 *   gpios                GPIOs that can be wired (the header GPIOs)
 *   notes                extra GPIO notes for this board (shown in tooltips and the GPIO panel)
 *   pullUp               bit mask of GPIOs pulled up by parts on the board
 *   buttons              { boot: {x, y}, rst: {x, y} } positions of the BOOT / RESET buttons
 *   led                  optional user LED: { gpio, activeLow, x, y, color }
 *   lab                  optional parts soldered on the board (drawn and simulated by app.js):
 *                        leds [{ gpio, label, x, y }] + ledColor (pin -> LED -> GND),
 *                        seg { x, y, color, pins: { a..g, dp: gpio } } (common cathode),
 *                        buttons [{ gpio, label, key, x, y }] (pin -> GND), jumpers [{ id, x, y, tip }]:
 *                        'LED' / '7S' enable the LEDs / display, 'PB' the buttons' pull-ups
 *   art()                SVG of the board body (drawn below the pins, buttons and LED)
 */
(function (root) {
  'use strict';

  const BOARDS = {
    devkitm1: {
      name: 'ESP32-C3-DevKitM-1',
      short: 'DevKitM-1',
      w: 180, h: 476, y0: 78, pitch: 24, lx: 14, rx: 166,
      left: ['GND', '3V3', '3V3', '2', '3', 'GND', 'RST', 'GND', '0', '1', '10', 'GND', '5V', '5V', 'GND'],
      right: ['GND', '21', '20', 'GND', '9', '8', 'GND', '7', '6', '5', '4', 'GND', '18', '19', 'GND'],
      gpios: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21],
      notes: { 8: 'strapping, RGB LED (not modelled)' },
      pullUp: 1 << 9,                                  // pull-up resistor on the BOOT button
      buttons: { boot: { x: 58, y: 420 }, rst: { x: 122, y: 420 } },
      led: null,
      art() {
        const antenna = 'M60 22 h56 v6 h-50 v6 h50 v6 h-56';
        return `
        <rect x="68" y="452" width="44" height="30" rx="3" fill="#b8bec8" stroke="#7d8591"/>
        <rect x="74" y="458" width="32" height="8" rx="2" fill="#5d6470"/>
        <rect width="${this.w}" height="${this.h}" rx="10" fill="#18202e" stroke="#0a0d13" stroke-width="2"/>
        <circle cx="12" cy="12" r="5" fill="#0a0d13"/><circle cx="168" cy="12" r="5" fill="#0a0d13"/>
        <circle cx="12" cy="${this.h - 12}" r="5" fill="#0a0d13"/><circle cx="168" cy="${this.h - 12}" r="5" fill="#0a0d13"/>
        <rect x="50" y="10" width="80" height="150" rx="3" fill="#1d2a22"/>
        <path d="${antenna}" fill="none" stroke="#c9a74a" stroke-width="2"/>
        <rect x="54" y="48" width="72" height="108" rx="3" fill="url(#shield)" stroke="#7e8590"/>
        <text x="90" y="86" class="chip-text" text-anchor="middle">ESP32-C3</text>
        <text x="90" y="100" class="chip-sub" text-anchor="middle">MINI-1</text>
        <text x="90" y="128" class="chip-sub" text-anchor="middle">RISC-V · 160 MHz</text>
        <text x="90" y="140" class="chip-sub" text-anchor="middle">400 KB SRAM</text>
        <rect x="${this.lx - 9}" y="${this.y0 - 12}" width="18" height="${this.pitch * 14 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="${this.rx - 9}" y="${this.y0 - 12}" width="18" height="${this.pitch * 14 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="70" y="182" width="40" height="40" rx="2" fill="#11151c" stroke="#2a3342"/>
        <text x="90" y="205" class="chip-sub light" text-anchor="middle">CP2102</text>
        <circle cx="76" cy="246" r="3.5" fill="#ff3b30"/>
        <text x="84" y="249" class="tiny light">PWR</text>
        <text x="90" y="300" class="board-title" text-anchor="middle">ESP32-C3</text>
        <text x="90" y="314" class="tiny light" text-anchor="middle">DevKitM-1</text>`;
      }
    },

    // ESP32-C3 SuperMini: USB-C at the top, chip side up. The USB port is the chip's own
    // USB-Serial-JTAG (GPIO18/19), so those pins are not on the headers.
    supermini: {
      name: 'ESP32-C3 SuperMini',
      short: 'SuperMini',
      w: 172, h: 300, y0: 78, pitch: 24, lx: 14, rx: 158,
      left: ['5', '6', '7', '8', '9', '10', '20', '21'],
      right: ['5V', 'GND', '3V3', '4', '3', '2', '1', '0'],
      gpios: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21],
      notes: { 8: 'strapping, blue LED (active low)' },
      pullUp: (1 << 9) | (1 << 8),                     // BOOT pull-up; the LED to 3V3 pulls GPIO8 up
      buttons: { boot: { x: 44, y: 40 }, rst: { x: 128, y: 40 } },
      led: { gpio: 8, activeLow: true, x: 86, y: 66, color: '#3a8bff' },
      art() {
        return `
        <rect x="58" y="-12" width="56" height="28" rx="6" fill="#b8bec8" stroke="#7d8591"/>
        <rect x="66" y="-6" width="40" height="8" rx="3" fill="#5d6470"/>
        <rect width="${this.w}" height="${this.h}" rx="8" fill="#1f2228" stroke="#0a0d13" stroke-width="2"/>
        <rect x="${this.lx - 9}" y="${this.y0 - 12}" width="18" height="${this.pitch * 7 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="${this.rx - 9}" y="${this.y0 - 12}" width="18" height="${this.pitch * 7 + 24}" rx="2" fill="#0b0d11"/>
        <circle cx="70" cy="66" r="3" fill="#ff3b30"/>
        <text x="62" y="69" class="tiny light" text-anchor="end">PWR</text>
        <text x="96" y="69" class="tiny light">IO8</text>
        <rect x="58" y="112" width="56" height="56" rx="3" fill="#2b2f36" stroke="#4a505b"/>
        <circle cx="64" cy="118" r="1.8" fill="#4a505b"/>
        <text x="86" y="136" class="chip-sub light" text-anchor="middle">ESP32-C3</text>
        <text x="86" y="149" class="chip-sub light" text-anchor="middle">FH4</text>
        <rect x="70" y="190" width="32" height="18" rx="2" fill="#11151c" stroke="#2a3342"/>
        <text x="86" y="202" class="tiny light" text-anchor="middle">LDO</text>
        <rect x="52" y="262" width="68" height="20" rx="2" fill="#c9a74a" opacity=".85"/>
        <text x="86" y="276" class="tiny" text-anchor="middle" style="fill:#3a2d0a">ANTENNA</text>
        <text x="86" y="236" class="board-title small" text-anchor="middle">SuperMini</text>`;
      }
    },

    // Seeed Studio XIAO ESP32C3: USB-C at the top, shield side up, castellated pads D0-D10;
    // BOOT, the U.FL antenna connector and RESET along the bottom edge. Like the SuperMini, the
    // USB port is the chip's USB-Serial-JTAG (GPIO18/19), and UART0 is on D7/D6 (GPIO20/21).
    // There is no user LED (the only LED is the charge indicator). Pinout and layout: Seeed
    // Studio XIAO ESP32-C3 product datasheet (SKU 113991054), "Hardware Overview".
    xiaoc3: {
      name: 'Seeed Studio XIAO ESP32C3',
      short: 'XIAO ESP32C3',
      w: 168, h: 262, y0: 60, pitch: 24, lx: 14, rx: 154,
      left: ['2', '3', '4', '5', '6', '7', '21'],
      right: ['5V', 'GND', '3V3', '10', '9', '8', '20'],
      gpios: [2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21],
      notes: {
        2: 'D0 / A0, strapping', 3: 'D1 / A1', 4: 'D2 / A2, JTAG MTMS', 5: 'D3 / A3, JTAG MTDI',
        6: 'D4 / SDA, JTAG MTCK', 7: 'D5 / SCL, JTAG MTDO', 21: 'D6 / TX, UART0 TX', 20: 'D7 / RX, UART0 RX',
        8: 'D8 / SCK, strapping', 9: 'D9 / MISO, BOOT button', 10: 'D10 / MOSI'
      },
      pullUp: 1 << 9,                                  // pull-up resistor on the BOOT button
      buttons: { boot: { x: 46, y: 226 }, rst: { x: 122, y: 226 } },
      led: null,
      art() {
        return `
        <rect width="${this.w}" height="${this.h}" rx="10" fill="#1b1d22" stroke="#0a0d13" stroke-width="2"/>
        <rect x="56" y="-12" width="56" height="44" rx="6" fill="#b8bec8" stroke="#7d8591"/>
        <rect x="68" y="18" width="10" height="8" rx="1" fill="#5d6470"/><rect x="90" y="18" width="10" height="8" rx="1" fill="#5d6470"/>
        <rect x="${this.lx - 9}" y="${this.y0 - 12}" width="18" height="${this.pitch * 6 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="${this.rx - 9}" y="${this.y0 - 12}" width="18" height="${this.pitch * 6 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="124" y="12" width="7" height="5" rx="1" fill="#ff3b30"/>
        <text x="127" y="28" class="tiny light" text-anchor="middle">CHG</text>
        <rect x="54" y="48" width="60" height="148" rx="4" fill="url(#shield)" stroke="#7e8590"/>
        <text x="84" y="86" class="chip-sub" text-anchor="middle">Seeed</text>
        <text x="84" y="98" class="chip-sub" text-anchor="middle">Studio</text>
        <text x="84" y="132" class="chip-text" text-anchor="middle">XIAO</text>
        <text x="84" y="148" class="chip-sub" text-anchor="middle">ESP32-C3</text>
        <circle cx="84" cy="226" r="8" fill="#c9a74a" stroke="#7d6a2c"/>
        <circle cx="84" cy="226" r="3" fill="#1b1d22"/>
        <text x="84" y="248" class="tiny light" text-anchor="middle">ANT</text>`;
      }
    },

    // Lab board: a SuperMini plugged into a carrier PCB with 8 LEDs (GPIO0..7, to GND through
    // a resistor each), a common-cathode 7-segment digit (a..g, dp on GPIO0..7, common to GND
    // through one resistor) and 4 push buttons to GND (PB1..PB4 on GPIO9, 10, 20, 21, with
    // 10k pull-ups). Jumpers LED / 7S connect the LED / display ground returns, jumper PB the
    // pull-ups. The wireable pins are the female headers J2 (left) / J1 (right) beside the
    // module, which repeat the SuperMini's pins.
    labc3: {
      name: 'ESP32-C3 Lab Board (SuperMini, 8 LEDs, 4 buttons, 7-seg)',
      short: 'Lab Board',
      w: 560, h: 440, y0: 40, pitch: 24, lx: 150, rx: 410,
      left: ['5', '6', '7', '8', '9', '10', '20', '21'],
      right: ['5V', 'GND', '3V3', '4', '3', '2', '1', '0'],
      gpios: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21],
      notes: {
        0: 'LED1, segment a', 1: 'LED2, segment b', 2: 'LED3, segment c, strapping', 3: 'LED4, segment d',
        4: 'LED5, segment e', 5: 'LED6, segment f', 6: 'LED7, segment g', 7: 'LED8, segment dp',
        8: 'strapping, blue LED (active low)', 9: 'PB1, BOOT button', 10: 'PB2', 20: 'PB3, U0RXD', 21: 'PB4, U0TXD'
      },
      pullUp: (1 << 9) | (1 << 8),                     // SuperMini: BOOT pull-up, LED to 3V3 on GPIO8
      buttons: { boot: { x: 244, y: 40 }, rst: { x: 316, y: 40 } },
      led: { gpio: 8, activeLow: true, x: 280, y: 78, color: '#3a8bff' },
      // On-board parts, drawn and simulated by app.js. Jumpers are on (installed on pins 1-2) by default.
      lab: {
        ledColor: '#ff3b30',
        leds: [0, 1, 2, 3, 4, 5, 6, 7].map(g => ({ gpio: g, label: 'LED' + (g + 1), x: 494, y: 40 + g * 50 })),
        seg: { x: 280, y: 346, color: '#ff3b30', pins: { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 } },
        buttons: [
          { gpio: 9, label: 'PB1', key: '1', x: 70, y: 64 },
          { gpio: 10, label: 'PB2', key: '2', x: 70, y: 162 },
          { gpio: 20, label: 'PB3', key: '3', x: 70, y: 260 },
          { gpio: 21, label: 'PB4', key: '4', x: 70, y: 358 }
        ],
        jumpers: [
          { id: '7S', x: 142, y: 370, tip: '7S: connects the 7-segment common cathode to GND' },
          { id: 'PB', x: 172, y: 370, tip: 'PB: connects the 10k pull-up resistors of PB1..PB4' },
          { id: 'LED', x: 410, y: 370, tip: 'LED: connects the LED resistors to GND' }
        ]
      },
      art() {
        const pcb = '#1d5fae', silk = '#e8eef7';
        let s = `
        <rect width="${this.w}" height="${this.h}" rx="8" fill="${pcb}" stroke="#0d2c55" stroke-width="2"/>
        <rect x="6" y="6" width="${this.w - 12}" height="${this.h - 12}" rx="5" fill="none" stroke="${silk}" stroke-width="1.2" opacity=".85"/>`;
        // header strips J2 / J1 (pins drawn by app.js)
        s += `<rect x="${this.lx - 10}" y="${this.y0 - 12}" width="20" height="${this.pitch * 7 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="${this.rx - 10}" y="${this.y0 - 12}" width="20" height="${this.pitch * 7 + 24}" rx="2" fill="#0b0d11"/>
        <text x="${this.lx}" y="${this.y0 + this.pitch * 7 + 26}" class="tiny" style="fill:${silk}" text-anchor="middle">J2</text>
        <text x="${this.rx}" y="${this.y0 + this.pitch * 7 + 26}" class="tiny" style="fill:${silk}" text-anchor="middle">J1</text>`;
        // the SuperMini module
        s += `<rect x="252" y="-8" width="56" height="26" rx="6" fill="#b8bec8" stroke="#7d8591"/>
        <rect x="260" y="-2" width="40" height="8" rx="3" fill="#5d6470"/>
        <rect x="196" y="12" width="168" height="236" rx="6" fill="#1f2228" stroke="${silk}" stroke-width="1.5"/>`;
        for (let i = 0; i < 8; i++) {
          s += `<circle cx="210" cy="${this.y0 + i * this.pitch}" r="4.5" fill="#b48f3a"/><circle cx="210" cy="${this.y0 + i * this.pitch}" r="2" fill="#14171c"/>
          <circle cx="350" cy="${this.y0 + i * this.pitch}" r="4.5" fill="#b48f3a"/><circle cx="350" cy="${this.y0 + i * this.pitch}" r="2" fill="#14171c"/>`;
        }
        s += `<circle cx="264" cy="78" r="3" fill="#ff3b30"/>
        <rect x="252" y="112" width="56" height="56" rx="3" fill="#2b2f36" stroke="#4a505b"/>
        <text x="280" y="137" class="chip-sub light" text-anchor="middle">ESP32-C3</text>
        <text x="280" y="150" class="chip-sub light" text-anchor="middle">FH4</text>
        <text x="280" y="192" class="board-title small" text-anchor="middle">ESP32C3</text>
        <text x="280" y="206" class="board-title small" text-anchor="middle">SuperMini</text>
        <rect x="246" y="222" width="68" height="16" rx="2" fill="#c9a74a" opacity=".85"/>`;
        // 7-segment display outline (the segments are drawn by app.js)
        s += `<rect x="196" y="264" width="168" height="164" rx="4" fill="none" stroke="${silk}" stroke-width="1.5"/>
        <rect x="231" y="271" width="98" height="150" rx="3" fill="#202226" stroke="#0e0f11" stroke-width="1.5"/>
        <rect x="239" y="280" width="82" height="132" rx="2" fill="#16171a"/>`;
        s += `<text x="${this.rx}" y="358" class="tiny" style="fill:${silk}" text-anchor="middle">LED</text>
        <text x="142" y="358" class="tiny" style="fill:${silk}" text-anchor="middle">7S</text>
        <text x="172" y="358" class="tiny" style="fill:${silk}" text-anchor="middle">PB</text>`;
        return s;
      }
    }
  };

  const out = { BOARDS, DEFAULT_BOARD: 'devkitm1' };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else Object.assign(root, out);
})(typeof window !== 'undefined' ? window : globalThis);
