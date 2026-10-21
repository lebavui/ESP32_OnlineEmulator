/*
 * TM1637 LED driver (Titan Micro TM1637 datasheet V2.4), as used on 4-digit 7-segment
 * display modules (pins CLK, DIO, VCC, GND; the module has 10k pull-ups on CLK and DIO).
 *
 * Two-wire interface. It looks like I2C but has no device address and sends data LSB first.
 * Start: DIO falls while CLK is high. Stop: DIO rises while CLK is high. DIO is read on each
 * rising edge of CLK and may only change while CLK is low. After 8 bits the chip pulls DIO
 * low (ACK) from the falling edge of the 8th clock to the falling edge of the 9th, so DIO
 * must be open-drain (or turned into an input) for the MCU to see it.
 *
 * The first byte after a start is a command:
 *   01xx xxxx  data command: bit 2 = fixed address (0 = auto-increment), bits 1:0 = 10 read keys
 *   11xx xaaa  address command: the following bytes of the same transfer go to display
 *              register aaa (0..5), then the next ones (auto-increment)
 *   10xx dppp  display control: d = display on, ppp = pulse width 1/16 … 14/16 (brightness)
 * Display register bits: D0 = segment a … D6 = g, D7 = dp (the colon on clock modules,
 * where it is wired to digit 1). Key scan isn't modelled: the chip never drives DIO during a
 * read, so the MCU reads 0xFF through the pull-up ("no key").
 * The model starts with the display off and all registers clear.
 */
(function (root) {
  'use strict';

  const PULSE = [1, 2, 4, 10, 11, 12, 13, 14];       // pulse width / 16 for ppp = 0..7

  class TM1637 {
    constructor() { this.reset(); }

    reset() {
      this.regs = new Uint8Array(6);
      this.on = false;
      this.pulse = 0;
      this.autoInc = true;
      this.addr = 0;
      this.clk = -1;
      this.dio = -1;
      this.active = false;          // between a start and a stop
      this.bits = 0;                // bits of the current byte received; 9 = in the ACK clock
      this.byte = 0;
      this.count = 0;               // bytes received since the start
      this.cmd = 0;                 // bits 7:6 of the first byte
      this.ack = false;             // the chip pulls DIO LOW
    }

    /** Feed the current CLK / DIO levels (0 or 1). */
    input(clk, dio) {
      if (clk === 1 && this.clk === 1 && this.dio !== -1 && dio !== this.dio) {
        if (dio === 0) {            // start
          this.active = true;
          this.bits = 0; this.byte = 0; this.count = 0;
        } else {                    // stop
          this.active = false;
        }
        this.ack = false;
      } else if (clk === 1 && this.clk === 0) {
        if (this.active && this.bits < 8) this.byte |= (dio & 1) << this.bits++;
      } else if (clk === 0 && this.clk === 1 && this.active) {
        if (this.bits === 8) {      // falling edge of the 8th clock: acknowledge
          this.take(this.byte);
          this.ack = true;
          this.bits = 9;
        } else if (this.bits === 9) { // falling edge of the 9th clock: release DIO
          this.ack = false;
          this.bits = 0;
          this.byte = 0;
        }
      }
      this.clk = clk;
      this.dio = dio;
    }

    take(b) {
      if (this.count++ === 0) {
        this.cmd = b & 0xC0;
        if (this.cmd === 0x40) this.autoInc = !(b & 4);
        else if (this.cmd === 0x80) { this.on = !!(b & 8); this.pulse = b & 7; }
        else if (this.cmd === 0xC0) this.addr = b & 7;
      } else if (this.cmd === 0xC0) {
        if (this.addr < this.regs.length) this.regs[this.addr] = b;
        if (this.autoInc) this.addr++;
      }
    }

    /** Segment pattern of each digit as it is lit (blank while the display is off). */
    segments() {
      return this.on ? Uint8Array.from(this.regs) : new Uint8Array(this.regs.length);
    }

    /** LED brightness 0..1: the pulse width set by the display control command. */
    brightness() {
      return this.on ? PULSE[this.pulse] / 16 : 0;
    }
  }

  const out = { TM1637 };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else Object.assign(root, out);
})(typeof window !== 'undefined' ? window : globalThis);
