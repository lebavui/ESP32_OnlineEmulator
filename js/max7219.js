/*
 * MAX7219 LED display driver (Maxim MAX7219/MAX7221 datasheet, 19-4452 Rev 4), as used on
 * 8x8 LED matrix modules, possibly daisy-chained (DOUT of one chip -> DIN of the next).
 *
 * Serial interface: DIN is shifted into a 16-bit register on each rising edge of CLK
 * (regardless of LOAD/CS), MSB first; the last 16 bits are latched on the rising edge of
 * LOAD/CS. Bits D15..D12 are don't care, D11..D8 the register address, D7..D0 the data.
 * In a chain, each chip's D15 (DOUT) feeds the next chip's DIN, so one frame is
 * 16 x chips bits and the first 16 bits sent end up in the chip farthest from the MCU.
 *
 * Registers: 0x0 no-op, 0x1..0x8 digit 0..7, 0x9 decode mode, 0xA intensity, 0xB scan limit,
 * 0xC shutdown (D0 = 1: normal operation), 0xF display test (D0 = 1: all LEDs on).
 * At power-up the chip is in shutdown, decode off, intensity and scan limit 0, digits blank.
 */
(function (root) {
  'use strict';

  // Code B font (datasheet Table 5) for digits 0..15: '0'..'9', '-', 'E', 'H', 'L', 'P', blank.
  // Segment bits: D6 = A, D5 = B, D4 = C, D3 = D, D2 = E, D1 = F, D0 = G (D7 = DP comes from the data).
  const CODE_B = [0x7E, 0x30, 0x6D, 0x79, 0x33, 0x5B, 0x5F, 0x70, 0x7F, 0x7B, 0x01, 0x4F, 0x37, 0x0E, 0x67, 0x00];

  class MAX7219Chip {
    constructor() { this.reset(); }

    reset() {
      this.digits = new Uint8Array(8);
      this.decode = 0;
      this.intensity = 0;
      this.scanLimit = 0;
      this.shutdown = true;
      this.test = false;
    }

    write(word) {
      const addr = (word >> 8) & 0xF, v = word & 0xFF;
      if (addr >= 1 && addr <= 8) this.digits[addr - 1] = v;
      else if (addr === 0x9) this.decode = v;
      else if (addr === 0xA) this.intensity = v & 0xF;
      else if (addr === 0xB) this.scanLimit = v & 7;
      else if (addr === 0xC) this.shutdown = !(v & 1);
      else if (addr === 0xF) this.test = !!(v & 1);
    }

    /** Segment / LED pattern of each digit as it is lit (blank in shutdown or beyond the scan limit). */
    rows() {
      const out = new Uint8Array(8);
      if (this.test) return out.fill(0xFF);          // display test overrides shutdown
      if (this.shutdown) return out;
      for (let i = 0; i <= this.scanLimit; i++) {
        const d = this.digits[i];
        out[i] = (this.decode >> i) & 1 ? (d & 0x80) | CODE_B[d & 0xF] : d;
      }
      return out;
    }

    /** LED brightness 0..1: the intensity register's PWM duty (2n+1)/32, full in display test. */
    brightness() {
      return this.test ? 1 : (2 * this.intensity + 1) / 32;
    }
  }

  class MAX7219Chain {
    constructor(count) {
      this.chips = Array.from({ length: Math.max(1, count | 0) }, () => new MAX7219Chip());
      this.shift = new Uint16Array(this.chips.length);   // shift[0] is the chip wired to the MCU
      this.clk = -1;
      this.cs = -1;
    }

    reset() {
      for (const c of this.chips) c.reset();
      this.shift.fill(0);
      this.clk = -1;
      this.cs = -1;
    }

    /** Feed the current DIN / CS / CLK levels (0 or 1); acts on the rising edges. */
    input(din, cs, clk) {
      if (clk === 1 && this.clk === 0) {
        let carry = din & 1;
        for (let i = 0; i < this.shift.length; i++) {
          const out = this.shift[i] >> 15;
          this.shift[i] = ((this.shift[i] << 1) | carry) & 0xFFFF;
          carry = out;
        }
      }
      if (cs === 1 && this.cs === 0) this.chips.forEach((c, i) => c.write(this.shift[i]));
      this.clk = clk;
      this.cs = cs;
    }
  }

  const out = { MAX7219Chip, MAX7219Chain };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else Object.assign(root, out);
})(typeof window !== 'undefined' ? window : globalThis);
