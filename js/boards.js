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
    }
  };

  const out = { BOARDS, DEFAULT_BOARD: 'devkitm1' };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else Object.assign(root, out);
})(typeof window !== 'undefined' ? window : globalThis);
