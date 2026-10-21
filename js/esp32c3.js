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
  const IO_MUX = 0x60009000;          // IO_MUX_GPIOn_REG = IO_MUX + 4 + 4 * n
  const SYSTIMER = 0x60023000;
  const USB_SERIAL = 0x60043000;

  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

  // IO_MUX_GPIOn_REG bits that the simulator models
  const FUN_WPD = 1 << 7, FUN_WPU = 1 << 8, FUN_IE = 1 << 9;
  const MCU_SEL_SHIFT = 12;           // MCU_SEL = bits 14:12, selects IO MUX function 0..2
  // Values a program sees when it starts, read back on a real ESP32-C3 after the ROM booted it
  // from flash (they match the datasheet's Table 2-1 "After Reset" column except GPIO6, which
  // has no pull-up, GPIO12/13, which the ROM's DIO flash setup switches to function 1, and
  // GPIO18/19/21). FUN_DRV = 2 (0x800) or 3 (0xC00), IE = 0x200, WPU = 0x100, MCU_SEL = 0x1000.
  const IOMUX_RESET = [
    0x800, 0x800, 0xA00, 0xA00, 0xA00, 0xA00, 0xA00, 0xA00,     // GPIO0..7  (0, 1: XTAL_32K, input off)
    0xA00, 0xB00, 0xA00, 0x800, 0x1B00, 0x1B00, 0xB00, 0xB00,   // GPIO8..15 (9: BOOT strapping, pulled up; 11..17: flash)
    0xB00, 0xB00, 0xC00, 0xC00, 0xB00, 0xB00                    // GPIO16..21 (18, 19: USB; 20: U0RXD; 21: U0TXD)
  ];
  // IO MUX functions F0, F1, F2 of each pin (datasheet Table 2-3). F1 is always GPIOn.
  const IOMUX_FUNCS = [
    ['GPIO0', 'GPIO0'], ['GPIO1', 'GPIO1'], ['GPIO2', 'GPIO2', 'FSPIQ'], ['GPIO3', 'GPIO3'],
    ['MTMS', 'GPIO4', 'FSPIHD'], ['MTDI', 'GPIO5', 'FSPIWP'], ['MTCK', 'GPIO6', 'FSPICLK'], ['MTDO', 'GPIO7', 'FSPID'],
    ['GPIO8', 'GPIO8'], ['GPIO9', 'GPIO9'], ['GPIO10', 'GPIO10', 'FSPICS0'], ['GPIO11', 'GPIO11'],
    ['SPIHD', 'GPIO12'], ['SPIWP', 'GPIO13'], ['SPICS0', 'GPIO14'], ['SPICLK', 'GPIO15'],
    ['SPID', 'GPIO16'], ['SPIQ', 'GPIO17'], ['GPIO18', 'GPIO18'], ['GPIO19', 'GPIO19'],
    ['U0RXD', 'GPIO20'], ['U0TXD', 'GPIO21']
  ];
  const U0TXD_PIN = 21;
  // GPIO19 (USB_D+) is pulled up by the USB Serial/JTAG PHY after reset ("USB_PU" in Table 2-1).
  const USB_PULLUP = 1 << 19;

  class ESP32C3 {
    constructor() {
      this.sram = new Uint8Array(SRAM_SIZE);
      this.dv = new DataView(this.sram.buffer);
      this.core = new RV32Core(this);
      // What the parts outside the chip do to each pin (bit masks):
      // force = pins connected to a level (value) by a pressed button / a switch,
      // pullUp / pullDown = resistors on the board (e.g. the BOOT button's pull-up on GPIO9).
      this.ext = { force: 0, value: 0, pullUp: 0, pullDown: 0 };
      this.tx = [];                 // bytes written to the serial port
      // Optional callback(levels) run whenever a pin level changes, at the instruction that
      // changed it: lets parts with a serial interface (MAX7219) see every clock edge.
      this.onPinsChanged = null;
      this.reset();
    }

    reset() {
      this.sram.fill(0);
      this.core.reset(IRAM_BASE);
      this.gpioOut = 0;
      this.gpioEnable = 0;
      this.iomux = Uint32Array.from(IOMUX_RESET);
      this.updateIomuxMasks();
      this.floatReads = 0;          // pins read through GPIO_IN_REG while floating
      this.ieOffReads = 0;          // pins read through GPIO_IN_REG with FUN_IE = 0
      this.noFnWrites = 0;          // output pins written through GPIO_OUT while not in the GPIO function
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
        case GPIO + 0x3C: return this.readInputs();
        case UART0 + 0x00: return this.uartRx.length ? this.uartRx.shift() : 0;
        case UART0 + 0x1C: return Math.min(this.uartRx.length, 0x3ff); // RXFIFO_CNT, TXFIFO_CNT = 0
        case SYSTIMER + 0x04: case SYSTIMER + 0x08: return 1 << 29; // VALUE_VALID
        case SYSTIMER + 0x40: return this.st0Hi;
        case SYSTIMER + 0x44: return this.st0Lo;
        case SYSTIMER + 0x48: return this.st1Hi;
        case SYSTIMER + 0x4C: return this.st1Lo;
        // EP1 FIFO / EP1_CONF: received bytes share the serial monitor's input queue with UART0
        case USB_SERIAL + 0x00: return this.uartRx.length ? this.uartRx.shift() : 0;
        case USB_SERIAL + 0x04: return 0x2 | (this.uartRx.length ? 0x4 : 0);  // IN_EP_DATA_FREE, OUT_EP_DATA_AVAIL
        default:
          if (addr >= IO_MUX + 4 && addr < IO_MUX + 4 + 4 * GPIO_COUNT) return this.iomux[(addr - IO_MUX - 4) >> 2];
          return this.periph.get(addr) | 0;
      }
    }

    periphWrite(addr, v) {
      switch (addr) {
        case GPIO + 0x04: this.gpioOut = v & GPIO_MASK; this.noteOutWrite(GPIO_MASK); this.pinsChanged(); return;
        case GPIO + 0x08: this.gpioOut = (this.gpioOut | v) & GPIO_MASK; this.noteOutWrite(v); this.pinsChanged(); return;
        case GPIO + 0x0C: this.gpioOut = this.gpioOut & ~v & GPIO_MASK; this.noteOutWrite(v); this.pinsChanged(); return;
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
      if (addr >= IO_MUX + 4 && addr < IO_MUX + 4 + 4 * GPIO_COUNT) {
        this.iomux[(addr - IO_MUX - 4) >> 2] = v & 0xffff;
        this.updateIomuxMasks();
        this.pinsChanged();
        return;
      }
      this.periph.set(addr, v >>> 0);
    }

    // ------------------------------------------------------------ pins

    updateIomuxMasks() {
      let ie = 0, wpu = 0, wpd = 0;
      for (let i = 0; i < GPIO_COUNT; i++) {
        const r = this.iomux[i];
        if (r & FUN_IE) ie |= 1 << i;
        if (r & FUN_WPU) wpu |= 1 << i;
        if (r & FUN_WPD) wpd |= 1 << i;
      }
      this.ieMask = ie; this.wpuMask = wpu; this.wpdMask = wpd;
      // Pins whose selected function is GPIOn: only these are driven by GPIO_OUT / GPIO_ENABLE.
      let fn = 0;
      for (let i = 0; i < GPIO_COUNT; i++) {
        const name = IOMUX_FUNCS[i][(this.iomux[i] >>> MCU_SEL_SHIFT) & 7];
        if (name && name.startsWith('GPIO')) fn |= 1 << i;
      }
      this.gpioFnMask = fn;
      // With function U0TXD selected, UART0 drives its idle level (high) onto GPIO21.
      this.uartTxMask = ((this.iomux[U0TXD_PIN] >>> MCU_SEL_SHIFT) & 7) === 0 ? 1 << U0TXD_PIN : 0;
    }

    /** Pins the chip itself drives (GPIO outputs in the GPIO function, plus U0TXD). */
    drivenPins() {
      return (this.gpioEnable & this.gpioFnMask) | this.uartTxMask;
    }

    /** Function name currently selected on a pin by IO_MUX MCU_SEL (undefined if reserved). */
    pinFunction(g) {
      return IOMUX_FUNCS[g][(this.iomux[g] >>> MCU_SEL_SHIFT) & 7];
    }

    // Record writes to GPIO_OUT that cannot reach a pin because its function is not GPIO.
    noteOutWrite(mask) {
      this.noFnWrites |= mask & this.gpioEnable & ~this.gpioFnMask & GPIO_MASK;
    }

    // Electrical level of every pin. Priority: the chip's own output driver, then a part that
    // connects the pin to GND / 3V3, then pull-up / pull-down resistors (internal or on the
    // board). A floating pin (none of these) is shown as low.
    levels() {
      const en = this.drivenPins(), f = this.ext.force & ~en;
      const up = (this.ext.pullUp | this.wpuMask | USB_PULLUP) & ~en & ~f;
      return ((this.gpioOut & en) | this.uartTxMask | (this.ext.value & f) | up) & GPIO_MASK;
    }

    /** Pins that nothing drives or pulls (their level is undefined on real hardware). */
    floatingPins() {
      return ~(this.drivenPins() | this.ext.force | this.ext.pullUp | this.ext.pullDown | this.wpuMask | this.wpdMask | USB_PULLUP) & GPIO_MASK;
    }

    // GPIO_IN_REG: only pins with FUN_IE set are seen by the input buffer.
    readInputs() {
      this.floatReads |= this.floatingPins() & this.ieMask;
      this.ieOffReads |= ~this.ieMask & GPIO_MASK;
      return this.levels() & this.ieMask;
    }

    pinsChanged() {
      const nl = this.levels();
      if (nl === this.lastLevels) return;
      this.accumulate();
      this.lastLevels = nl;
      if (this.onPinsChanged) this.onPinsChanged(nl);
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

    /**
     * Set what external parts do to the pins: { force, value, pullUp, pullDown } bit masks.
     * A plain number forces every pin to that level (handy in tests).
     */
    setExternal(ext) {
      if (typeof ext === 'number') ext = { force: GPIO_MASK, value: ext };
      this.ext = {
        force: (ext.force | 0) & GPIO_MASK, value: (ext.value | 0) & GPIO_MASK,
        pullUp: (ext.pullUp | 0) & GPIO_MASK, pullDown: (ext.pullDown | 0) & GPIO_MASK
      };
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
    SRAM_SIZE, DRAM_BASE, IRAM_BASE, STACK_TOP, CPU_HZ, GPIO_COUNT, IO_MUX, IOMUX_RESET, IOMUX_FUNCS, FUN_IE, FUN_WPU, FUN_WPD,
    UART0, GPIO, SYSTIMER, USB_SERIAL
  });

  if (isNode) module.exports = { ESP32C3, SimError };
  else root.ESP32C3 = ESP32C3;
})(typeof window !== 'undefined' ? window : globalThis);
