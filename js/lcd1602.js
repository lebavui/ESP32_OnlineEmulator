/*
 * 16x2 character LCD (LCD1602) with an HD44780-compatible controller (Hitachi HD44780U
 * datasheet, ADE-207-272), wired in 4-bit mode (RS, RW, E, D4..D7), and the I2C backpack
 * that drives one through a PCF8574 I/O expander (NXP PCF8574 datasheet, Rev. 5).
 *
 * HD44780: an instruction or data byte is latched on the falling edge of E. After power-up
 * the controller is in 8-bit mode, so the 4-bit initialisation sends the nibble 3 three
 * times and then 2 (each one E pulse, read as the byte 0x30 / 0x20 with D0..D3 = 0); from
 * then on every byte is two E pulses, high nibble first. With RW = 1 the controller drives
 * D4..D7 while E is high: RS = 0 reads the busy flag (D7) and the address counter, RS = 1
 * reads the RAM at the address counter. Execution times (fosc = 270 kHz): clear display
 * and return home 1.52 ms, everything else 37 us (+4 us for RAM writes and reads). A byte
 * that arrives while the controller is busy is lost (counted in `lost`), and the
 * controller stays busy for 15 ms after power-up (here: after the program starts).
 *
 * PCF8574 I2C backpack: P0 = RS, P1 = RW, P2 = E, P3 = backlight, P4..P7 = D4..D7.
 * I2C: start = SDA falls while SCL is high, stop = SDA rises while SCL is high; bytes go
 * MSB first, read on rising SCL edges, and the receiver pulls SDA low on the 9th clock to
 * acknowledge. The address byte is 7-bit address << 1 | R/W (0x27 for PCF8574 with
 * A2..A0 = 1, the usual backpack; 0x3F for PCF8574A). A write byte sets the port pins; a
 * read returns the port pins, where a pin written 1 is only weakly pulled up, so the LCD
 * can pull it low. The port powers up all high.
 */
(function (root) {
  'use strict';

  const POWER_ON_US = 15000;

  // HD44780U character ROM A00, codes 0x20..0x7F: 5 column bytes per character, bit 0 = top row.
  const ROM_A00 =
    '0000000000 00005F0000 0007000700 147F147F14 242A7F2A12 2313086462 3649552250 0005030000 ' +
    '001C224100 0041221C00 082A1C2A08 08083E0808 0050300000 0808080808 0060600000 2010080402 ' +
    '3E5149453E 00427F4000 4261514946 2141454B31 1814127F10 2745454539 3C4A494930 0171090503 ' +
    '3649494936 064949291E 0036360000 0056360000 0814224100 1414141414 0041221408 0201510906 ' +
    '324979413E 7E1111117E 7F49494936 3E41414122 7F4141221C 7F49494941 7F09090101 3E41415132 ' +
    '7F0808087F 00417F4100 2040413F01 7F08142241 7F40404040 7F020C027F 7F0408107F 3E4141413E ' +
    '7F09090906 3E4151215E 7F09192946 4649494931 01017F0101 3F4040403F 1F2040201F 3F4038403F ' +
    '6314081463 0708700807 6151494543 007F414100 15167C1615 0041417F00 0402010204 4040404040 ' +
    '0001020400 2054545478 7F48444438 3844444420 384444487F 3854545418 087E090102 0C5252523E ' +
    '7F08040478 00447D4000 2040443D00 7F10284400 00417F4000 7C04180478 7C08040478 3844444438 ' +
    '7C14141408 081414187C 7C08040408 4854545420 043F444020 3C4040207C 1C2040201C 3C4030403C ' +
    '4428102844 0C5050503C 4464544C44 0008364100 00007F0000 0041360800 08082A1C08 081C2A0808';

  const FONT = new Map();          // code -> 8 rows, bit 4 = leftmost column
  ROM_A00.split(' ').forEach((hex, i) => {
    const cols = [0, 2, 4, 6, 8].map(k => parseInt(hex.slice(k, k + 2), 16));
    FONT.set(0x20 + i, Uint8Array.from({ length: 8 }, (_, r) => cols.reduce((v, c, k) => v | ((c >> r) & 1) << (4 - k), 0)));
  });
  FONT.set(0xDF, Uint8Array.of(0x1C, 0x14, 0x1C, 0, 0, 0, 0, 0));   // degree sign
  FONT.set(0xFF, new Uint8Array(8).fill(0x1F));                     // full block
  const BLANK = new Uint8Array(8);

  class HD44780 {
    constructor(cyclesPerUs = 160) {
      this.cpu = cyclesPerUs;
      this.reset();
    }

    // Power-on state after the internal reset: display cleared, 8-bit interface, 1 line,
    // display / cursor / blink off, increment without display shift.
    reset() {
      this.ddram = new Uint8Array(128).fill(0x20);
      this.cgram = new Uint8Array(64);
      this.ac = 0;
      this.cg = false;              // the address counter points into CGRAM
      this.inc = true;
      this.shiftOnWrite = false;
      this.on = false;
      this.cursor = false;
      this.blink = false;
      this.dl8 = true;
      this.lines2 = false;
      this.shift = 0;               // display shift: DDRAM column shown in the first column
      this.half = false;            // 4-bit mode: the high nibble has been transferred
      this.hi = 0;
      this.rbyte = 0;
      this.out = null;              // nibble driven on D4..D7 during a read
      this.e = -1;
      this.rw = 0;
      this.busyUntil = POWER_ON_US * this.cpu;
      this.lost = 0;                // bytes written while busy
    }

    busy(cycle) { return cycle < this.busyUntil; }

    /** Feed the RS, RW, E levels and the D7..D4 nibble at CPU cycle `cycle`. */
    input(rs, rw, e, d, cycle) {
      const prevE = this.e;
      this.e = e;
      this.rw = rw;
      if (e === 1 && prevE === 0) {
        if (rw) {
          if (this.dl8 || !this.half) {
            this.rbyte = rs ? (this.cg ? this.cgram[this.ac & 0x3F] : this.ddram[this.ac & 0x7F])
              : (this.busy(cycle) ? 0x80 : 0) | (this.ac & 0x7F);
          }
          this.out = this.dl8 || !this.half ? this.rbyte >> 4 : this.rbyte & 15;
        } else this.out = null;
      } else if (e === 0 && prevE === 1) {
        if (rw) {
          const done = this.dl8 || this.half;
          if (!this.dl8) this.half = !this.half;
          if (done && rs && !this.busy(cycle)) {
            this.advance(this.inc ? 1 : -1);
            this.busyUntil = cycle + 4 * this.cpu;
          }
        } else if (this.dl8) this.exec(rs, (d & 15) << 4, cycle);
        else if (!this.half) { this.hi = d & 15; this.half = true; }
        else { this.half = false; this.exec(rs, this.hi << 4 | (d & 15), cycle); }
        this.out = null;
      }
    }

    /** Nibble the controller drives on D7..D4 (RW = 1 and E = 1), or null. */
    output() {
      return this.e === 1 && this.rw === 1 ? this.out : null;
    }

    exec(rs, b, cycle) {
      if (this.busy(cycle)) {
        if (rs || b) this.lost++;   // instruction 0x00 does nothing anyway (e.g. E falling on the backpack's first write)
        return;
      }
      let us = 37;
      if (rs) {
        if (this.cg) this.cgram[this.ac & 0x3F] = b;
        else {
          this.ddram[this.ac & 0x7F] = b;
          if (this.shiftOnWrite) this.shift += this.inc ? 1 : -1;
        }
        this.advance(this.inc ? 1 : -1);
        us = 41;
      } else if (b & 0x80) { this.cg = false; this.ac = b & 0x7F; }
      else if (b & 0x40) { this.cg = true; this.ac = b & 0x3F; }
      else if (b & 0x20) { this.dl8 = !!(b & 0x10); this.lines2 = !!(b & 0x08); this.half = false; }
      else if (b & 0x10) {
        if (b & 0x08) this.shift += b & 0x04 ? -1 : 1;      // display shift right / left
        else this.advance(b & 0x04 ? 1 : -1);               // cursor move right / left
      } else if (b & 0x08) { this.on = !!(b & 4); this.cursor = !!(b & 2); this.blink = !!(b & 1); }
      else if (b & 0x04) { this.inc = !!(b & 2); this.shiftOnWrite = !!(b & 1); }
      else if (b & 0x02) { this.ac = 0; this.cg = false; this.shift = 0; us = 1520; }
      else if (b & 0x01) { this.ddram.fill(0x20); this.ac = 0; this.cg = false; this.shift = 0; this.inc = true; us = 1520; }
      this.busyUntil = cycle + us * this.cpu;
    }

    // Move the address counter; DDRAM wraps 0x27 -> 0x40 -> 0x67 -> 0x00 with 2 lines,
    // 0x4F -> 0x00 with 1 line.
    advance(dir) {
      if (this.cg) { this.ac = (this.ac + dir) & 0x3F; return; }
      let a = this.ac + dir;
      if (this.lines2) {
        if (a === 0x28) a = 0x40;
        else if (a === 0x3F) a = 0x27;
        else if (a > 0x67) a = 0;
        else if (a < 0) a = 0x67;
      } else if (a > 0x4F) a = 0;
      else if (a < 0) a = 0x4F;
      this.ac = a;
    }

    /**
     * What the 16x2 glass shows: { on, rows: [16 codes, 16 codes], cursor: {row, col} or
     * null, underline, blink }. With 1 line, the second row is not driven (codes -1).
     */
    screen() {
      const rows = [new Int16Array(16).fill(0x20), new Int16Array(16).fill(this.lines2 ? 0x20 : -1)];
      let cursor = null;
      const mod = (v, n) => ((v % n) + n) % n;
      for (let c = 0; c < 16; c++) {
        for (let r = 0; r < (this.lines2 ? 2 : 1); r++) {
          const a = this.lines2 ? r * 0x40 + mod(c + this.shift, 40) : mod(c + this.shift, 80);
          rows[r][c] = this.ddram[a];
          if (!this.cg && a === this.ac) cursor = { row: r, col: c };
        }
      }
      return { on: this.on, rows, cursor: this.cursor || this.blink ? cursor : null, underline: this.cursor, blink: this.blink };
    }

    /** 8 pixel rows (bit 4 = leftmost column) of character `code` (CGRAM for 0x00..0x0F). */
    glyph(code) {
      if (code < 0) return BLANK;
      if (code < 0x10) return this.cgram.subarray((code & 7) * 8, (code & 7) * 8 + 8).map(v => v & 0x1F);
      return FONT.get(code) || BLANK;
    }
  }

  class LCDI2C {
    constructor(addr = 0x27, cyclesPerUs = 160) {
      this.addr = addr;
      this.lcd = new HD44780(cyclesPerUs);
      this.reset();
    }

    reset() {
      this.lcd.reset();
      this.port = 0xFF;
      this.lcd.input(1, 1, 1, 15, 0);
      this.scl = -1;
      this.sda = -1;
      this.state = 'idle';          // 'idle' | 'addr' | 'write' | 'read'
      this.n = 0;                   // rising SCL edges in the current byte (9 = ACK clock)
      this.byte = 0;
      this.out = 0;                 // byte being sent to the master
      this.slaveAck = false;        // the 9th clock is our ACK (not the master's)
      this.ackBit = 1;
      this.sink = false;            // the PCF8574 pulls SDA LOW
    }

    get backlight() { return !!(this.port & 8); }

    setPort(b, cycle) {
      this.port = b;
      this.lcd.input(b & 1, (b >> 1) & 1, (b >> 2) & 1, b >> 4, cycle);
    }

    readPort() {
      const d = this.lcd.output();
      return d === null ? this.port : this.port & (0x0F | d << 4);
    }

    /** Feed the current SCL / SDA levels (0 or 1) at CPU cycle `cycle`. */
    input(scl, sda, cycle) {
      const pScl = this.scl, pSda = this.sda;
      this.scl = scl;
      this.sda = sda;
      if (pScl === -1) return;
      if (scl === 1 && pScl === 1) {
        if (sda !== pSda) {          // start (SDA falls) or stop (SDA rises)
          this.state = sda ? 'idle' : 'addr';
          this.n = 0; this.byte = 0; this.sink = false; this.slaveAck = false;
        }
        return;
      }
      if (this.state === 'idle') return;
      if (scl === 1 && pScl === 0) {
        if (++this.n <= 8) this.byte = ((this.byte << 1) | sda) & 0xFF;
        else this.ackBit = sda;
        return;
      }
      if (scl !== 0 || pScl !== 1) return;
      if (this.n === 8) {            // after the 8th bit
        if (this.state === 'addr') {
          if ((this.byte >> 1) !== this.addr) { this.state = 'idle'; return; }
          this.state = this.byte & 1 ? 'read' : 'write';
          this.sink = this.slaveAck = true;
        } else if (this.state === 'write') {
          this.setPort(this.byte, cycle);
          this.sink = this.slaveAck = true;
        } else this.sink = false;    // read: release SDA for the master's ACK
      } else if (this.n === 9) {     // end of the ACK clock
        this.n = 0; this.byte = 0;
        if (this.state === 'read' && (this.slaveAck || this.ackBit === 0)) {
          this.out = this.readPort();
          this.sink = !(this.out & 0x80);
        } else {
          this.sink = false;
          if (this.state === 'read') this.state = 'idle';   // master NACK: done until the next start
        }
        this.slaveAck = false;
      } else if (this.state === 'read') {
        this.sink = !((this.out >> (7 - this.n)) & 1);
      }
    }
  }

  const out = { HD44780, LCDI2C };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else Object.assign(root, out);
})(typeof window !== 'undefined' ? window : globalThis);
