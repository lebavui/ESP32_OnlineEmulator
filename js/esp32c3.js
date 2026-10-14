/*
 * ESP32-C3 system model: memory map, GPIO, SYSTIMER, UART0, USB-Serial-JTAG
 * plus a few simulator-only "ecall" services.
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const { RV32Core, SimError } = isNode ? require('./cpu.js') : root;

  const SRAM_SIZE = 0x60000;          // 384 KB internal SRAM
  const DRAM_BASE = 0x3FC80000;       // data bus view
  const IRAM_BASE = 0x40380000;       // instruction bus view (same memory)
  const STACK_TOP = DRAM_BASE + SRAM_SIZE - 16;
  const CPU_HZ = 160000000;
  const SYSTIMER_DIV = 10;            // SYSTIMER counts at 16 MHz
  const GPIO_COUNT = 22;
  const GPIO_MASK = (1 << GPIO_COUNT) - 1;

  const PERIPH_LO = 0x60000000, PERIPH_HI = 0x600D0FFF;
  const UART0 = 0x60000000;
  const GPIO = 0x60004000;
  const SYSTIMER = 0x60023000;
  const USB_SERIAL = 0x60043000;

  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

  class ESP32C3 {
    constructor() {
      this.sram = new Uint8Array(SRAM_SIZE);
      this.dv = new DataView(this.sram.buffer);
      this.core = new RV32Core(this);
      this.extLevel = 0;            // levels driven onto pins by external parts
      this.tx = [];                 // bytes written to the serial port
      this.reset();
    }

    reset() {
      this.sram.fill(0);
      this.core.reset(IRAM_BASE);
      this.gpioOut = 0;
      this.gpioEnable = 0;
      this.periph = new Map();
      this.uartRx = [];
      this.tx.length = 0;
      this.event = null;
      this.halted = false;
      this.haltMessage = '';
      this.error = null;
      this.sleepUntil = 0;
      this.loaded = false;
      this.st0Lo = 0; this.st0Hi = 0; this.st1Lo = 0; this.st1Hi = 0;
      this.lastLevels = this.levels();
      this.highTime = new Float64Array(GPIO_COUNT);
      this.lastAccCycle = 0;
      this.sampleStart = 0;
    }

    load(prog) {
      this.reset();
      const t = prog.text, d = prog.data;
      const tOff = t.base - IRAM_BASE, dOff = d.base - DRAM_BASE;
      if (tOff + t.bytes.length > dOff) throw new Error('Program code is too large (overlaps .data)');
      if (dOff + d.bytes.length > STACK_TOP - DRAM_BASE - 4096) throw new Error('.data section is too large');
      this.sram.set(t.bytes, tOff);
      this.sram.set(d.bytes, dOff);
      this.core.reset(prog.entry);
      this.core.x[2] = STACK_TOP;      // sp
      this.core.x[3] = d.base;         // gp
      this.loaded = true;
    }

    get timeSeconds() { return this.core.cycle / CPU_HZ; }

    // ------------------------------------------------------------ bus

    fault(msg) { throw new SimError(msg, this.core.pc); }

    offset(addr) {
      let o = (addr - DRAM_BASE) >>> 0;
      if (o < SRAM_SIZE) return o;
      o = (addr - IRAM_BASE) >>> 0;
      if (o < SRAM_SIZE) return o;
      return -1;
    }

    fetch(addr) {
      const o = (addr - IRAM_BASE) >>> 0;
      if (o < SRAM_SIZE && (addr & 3) === 0) return this.dv.getInt32(o, true);
      if (addr & 3) this.fault(`Instruction address misaligned: ${hex(addr)}`);
      this.fault(`Instruction access fault: cannot execute from ${hex(addr)}`);
    }

    read8(addr) {
      const o = this.offset(addr);
      if (o >= 0) return this.sram[o];
      if (addr >= PERIPH_LO && addr <= PERIPH_HI) return (this.periphRead(addr & ~3) >>> ((addr & 3) * 8)) & 0xff;
      this.fault(`Load access fault at ${hex(addr)} (unmapped address)`);
    }

    read16(addr) {
      if (addr & 1) this.fault(`Misaligned 16-bit load at ${hex(addr)}`);
      const o = this.offset(addr);
      if (o >= 0) return this.dv.getUint16(o, true);
      if (addr >= PERIPH_LO && addr <= PERIPH_HI) return (this.periphRead(addr & ~3) >>> ((addr & 3) * 8)) & 0xffff;
      this.fault(`Load access fault at ${hex(addr)} (unmapped address)`);
    }

    read32(addr) {
      if (addr & 3) this.fault(`Misaligned 32-bit load at ${hex(addr)}`);
      const o = this.offset(addr);
      if (o >= 0) return this.dv.getUint32(o, true);
      if (addr >= PERIPH_LO && addr <= PERIPH_HI) return this.periphRead(addr) >>> 0;
      this.fault(`Load access fault at ${hex(addr)} (unmapped address)`);
    }

    write8(addr, v) {
      const o = this.offset(addr);
      if (o >= 0) { this.sram[o] = v; return; }
      if (addr >= PERIPH_LO && addr <= PERIPH_HI) { this.periphWrite(addr & ~3, (v & 0xff) << ((addr & 3) * 8)); return; }
      this.fault(`Store access fault at ${hex(addr)} (unmapped address)`);
    }

    write16(addr, v) {
      if (addr & 1) this.fault(`Misaligned 16-bit store at ${hex(addr)}`);
      const o = this.offset(addr);
      if (o >= 0) { this.dv.setUint16(o, v, true); return; }
      if (addr >= PERIPH_LO && addr <= PERIPH_HI) { this.periphWrite(addr & ~3, (v & 0xffff) << ((addr & 3) * 8)); return; }
      this.fault(`Store access fault at ${hex(addr)} (unmapped address)`);
    }

    write32(addr, v) {
      if (addr & 3) this.fault(`Misaligned 32-bit store at ${hex(addr)}`);
      const o = this.offset(addr);
      if (o >= 0) { this.dv.setUint32(o, v, true); return; }
      if (addr >= PERIPH_LO && addr <= PERIPH_HI) { this.periphWrite(addr, v >>> 0); return; }
      this.fault(`Store access fault at ${hex(addr)} (unmapped address)`);
    }

    // ------------------------------------------------------------ peripherals

    periphRead(addr) {
      switch (addr) {
        case GPIO + 0x04: return this.gpioOut;
        case GPIO + 0x08: case GPIO + 0x0C: return 0;
        case GPIO + 0x20: return this.gpioEnable;
        case GPIO + 0x24: case GPIO + 0x28: return 0;
        case GPIO + 0x3C: return this.levels();
        case UART0 + 0x00: return this.uartRx.length ? this.uartRx.shift() : 0;
        case UART0 + 0x1C: return Math.min(this.uartRx.length, 0x3ff); // RXFIFO_CNT, TXFIFO_CNT = 0
        case SYSTIMER + 0x04: case SYSTIMER + 0x08: return 1 << 29; // VALUE_VALID
        case SYSTIMER + 0x40: return this.st0Hi;
        case SYSTIMER + 0x44: return this.st0Lo;
        case SYSTIMER + 0x48: return this.st1Hi;
        case SYSTIMER + 0x4C: return this.st1Lo;
        case USB_SERIAL + 0x04: return 0x2;  // SERIAL_IN_EP_DATA_FREE
        default: return this.periph.get(addr) | 0;
      }
    }

    periphWrite(addr, v) {
      switch (addr) {
        case GPIO + 0x04: this.gpioOut = v & GPIO_MASK; this.pinsChanged(); return;
        case GPIO + 0x08: this.gpioOut = (this.gpioOut | v) & GPIO_MASK; this.pinsChanged(); return;
        case GPIO + 0x0C: this.gpioOut = this.gpioOut & ~v & GPIO_MASK; this.pinsChanged(); return;
        case GPIO + 0x20: this.gpioEnable = v & GPIO_MASK; this.pinsChanged(); return;
        case GPIO + 0x24: this.gpioEnable = (this.gpioEnable | v) & GPIO_MASK; this.pinsChanged(); return;
        case GPIO + 0x28: this.gpioEnable = this.gpioEnable & ~v & GPIO_MASK; this.pinsChanged(); return;
        case UART0 + 0x00: this.tx.push(v & 0xff); return;
        case USB_SERIAL + 0x00: this.tx.push(v & 0xff); return;
        case SYSTIMER + 0x04:
          if (v & (1 << 30)) {
            const t = Math.floor(this.core.cycle / SYSTIMER_DIV);
            this.st0Lo = t | 0;
            this.st0Hi = Math.floor(t / 4294967296) & 0xfffff;
          }
          return;
        case SYSTIMER + 0x08:
          if (v & (1 << 30)) {
            const t = Math.floor(this.core.cycle / SYSTIMER_DIV);
            this.st1Lo = t | 0;
            this.st1Hi = Math.floor(t / 4294967296) & 0xfffff;
          }
          return;
      }
      this.periph.set(addr, v >>> 0);
    }

    // ------------------------------------------------------------ pins

    levels() {
      return ((this.gpioOut & this.gpioEnable) | (this.extLevel & ~this.gpioEnable)) & GPIO_MASK;
    }

    pinsChanged() {
      const nl = this.levels();
      if (nl === this.lastLevels) return;
      this.accumulate();
      this.lastLevels = nl;
    }

    accumulate() {
      const now = this.core.cycle;
      const dt = now - this.lastAccCycle;
      if (dt > 0) {
        const lv = this.lastLevels;
        for (let i = 0; i < GPIO_COUNT; i++) if ((lv >>> i) & 1) this.highTime[i] += dt;
      }
      this.lastAccCycle = now;
    }

    /** Fraction of time each pin was high since the previous call (for PWM / multiplexing). */
    sampleDuty() {
      this.accumulate();
      const span = this.core.cycle - this.sampleStart;
      const out = new Float32Array(GPIO_COUNT);
      for (let i = 0; i < GPIO_COUNT; i++) {
        out[i] = span > 0 ? Math.min(1, this.highTime[i] / span) : (this.lastLevels >>> i) & 1;
      }
      this.highTime.fill(0);
      this.sampleStart = this.core.cycle;
      return out;
    }

    setExternal(level) {
      this.extLevel = level & GPIO_MASK;
      this.pinsChanged();
    }

    uartReceive(bytes) {
      for (const b of bytes) this.uartRx.push(b & 0xff);
    }

    // ------------------------------------------------------------ simulator services

    readCString(addr, max = 4096) {
      const out = [];
      for (let i = 0; i < max; i++) {
        const b = this.read8((addr + i) >>> 0);
        if (!b) break;
        out.push(b);
      }
      return out;
    }

    print(str) {
      for (const b of new TextEncoder().encode(str)) this.tx.push(b);
    }

    onEcall(core) {
      const a0 = core.x[10], a7 = core.x[17];
      switch (a7) {
        case 1: this.print(String(a0)); break;                                        // print_int
        case 4: this.tx.push(...this.readCString(a0 >>> 0)); break;                   // print_string
        case 11: this.tx.push(a0 & 0xff); break;                                      // print_char
        case 34: this.print('0x' + (a0 >>> 0).toString(16).padStart(8, '0')); break; // print_hex
        case 35: this.print((a0 >>> 0).toString(2).padStart(32, '0')); break;         // print_bin
        case 36: this.print(String(a0 >>> 0)); break;                                 // print_uint
        case 30: {                                                                     // time (ms)
          const ms = Math.floor(core.cycle / (CPU_HZ / 1000));
          core.x[10] = ms % 4294967296 | 0;
          core.x[11] = Math.floor(ms / 4294967296) | 0;
          break;
        }
        case 32:                                                                       // sleep (ms)
          this.sleepUntil = core.cycle + 1 + Math.max(0, a0) * (CPU_HZ / 1000);
          this.event = 'sleep';
          break;
        case 12: {                                                                     // read_char
          if (!this.uartRx.length) { core.x[10] = -1; break; }
          core.x[10] = this.uartRx.shift();
          break;
        }
        case 10: this.halt('Program exited'); break;
        case 93: this.halt(`Program exited with code ${a0}`); break;
        default:
          throw new SimError(`Unsupported ecall service a7=${a7} at ${hex(core.pc)}`, core.pc);
      }
    }

    onEbreak() { this.event = 'ebreak'; }

    halt(msg) {
      this.halted = true;
      this.haltMessage = msg;
      this.event = 'halt';
    }

    // ------------------------------------------------------------ execution

    /**
     * Run until core.cycle reaches targetCycle, a breakpoint/halt/error occurs,
     * or wall-clock deadline (performance.now()) passes.
     */
    run(targetCycle, breakpoints, deadline, skipFirstBreakpoint) {
      const core = this.core;
      if (this.halted) return 'halt';
      const useBp = breakpoints && breakpoints.size > 0;
      let skip = !!skipFirstBreakpoint;
      try {
        while (core.cycle < targetCycle) {
          if (this.sleepUntil > core.cycle) {
            core.cycle = Math.min(Math.ceil(targetCycle), this.sleepUntil);
            continue;
          }
          let n = Math.min(Math.ceil(targetCycle - core.cycle), 8192);
          if (useBp) {
            while (n-- > 0) {
              if (!skip && breakpoints.has(core.pc)) return 'breakpoint';
              skip = false;
              core.step();
              if (this.event) break;
            }
          } else {
            while (n-- > 0) {
              core.step();
              if (this.event) break;
            }
          }
          if (this.event) {
            const e = this.event;
            this.event = null;
            if (e === 'halt') return 'halt';
            if (e === 'ebreak') return 'ebreak';
          }
          if (performance.now() > deadline) return 'time';
        }
      } catch (e) {
        if (e instanceof SimError) {
          this.halted = true;
          this.error = e;
          return 'error';
        }
        throw e;
      }
      return 'budget';
    }

    /** Execute exactly one instruction (skipping over any pending sleep). */
    stepOnce() {
      if (this.halted) return 'halt';
      const core = this.core;
      if (this.sleepUntil > core.cycle) core.cycle = this.sleepUntil;
      try {
        core.step();
      } catch (e) {
        if (e instanceof SimError) { this.halted = true; this.error = e; return 'error'; }
        throw e;
      }
      const e = this.event;
      this.event = null;
      return e === 'halt' ? 'halt' : e === 'ebreak' ? 'ebreak' : 'ok';
    }
  }

  Object.assign(ESP32C3, {
    SRAM_SIZE, DRAM_BASE, IRAM_BASE, STACK_TOP, CPU_HZ, GPIO_COUNT,
    UART0, GPIO, SYSTIMER, USB_SERIAL
  });

  if (isNode) module.exports = { ESP32C3, SimError };
  else root.ESP32C3 = ESP32C3;
})(typeof window !== 'undefined' ? window : globalThis);
