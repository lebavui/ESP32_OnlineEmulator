/*
 * RV32IM + Zicsr interpreter core.
 *
 * The core talks to the outside world through a "bus" object that provides:
 *   fetch(addr), read8/16/32(addr), write8/16/32(addr, value),
 *   onEcall(core), onEbreak(core)
 */
(function (root) {
  'use strict';

  class SimError extends Error {
    constructor(message, pc) {
      super(message);
      this.pc = pc;
    }
  }

  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

  class RV32Core {
    constructor(bus) {
      this.bus = bus;
      this.x = new Int32Array(32);
      this.pc = 0;
      this.cycle = 0;
      this.instret = 0;
      this.csr = new Map();
    }

    reset(pc) {
      this.x.fill(0);
      this.pc = (pc || 0) >>> 0;
      this.cycle = 0;
      this.instret = 0;
      this.csr.clear();
    }

    illegal(inst) {
      throw new SimError(`Illegal instruction ${hex(inst)} at ${hex(this.pc)}`, this.pc);
    }

    readCsr(n) {
      switch (n) {
        case 0xC00: case 0xB00: case 0xC01: return this.cycle % 4294967296 | 0;
        case 0xC80: case 0xB80: case 0xC81: return Math.floor(this.cycle / 4294967296) | 0;
        case 0xC02: case 0xB02: return this.instret % 4294967296 | 0;
        case 0xC82: case 0xB82: return Math.floor(this.instret / 4294967296) | 0;
        case 0x301: return 0x40101104;   // misa: RV32 I M C U (as read from an ESP32-C3)
        case 0x7E2: return (this.cycle - (this.csr.get(0x7E2) || 0)) % 4294967296 | 0;   // mpccr: Espressif cycle counter
        case 0xF11: return 0x612;        // mvendorid: Espressif
        case 0xF12: case 0xF13: case 0xF14: return 0;
        default: return this.csr.get(n) | 0;
      }
    }

    writeCsr(n, v) {
      if ((n >>> 10) === 3) throw new SimError(`Write to read-only CSR 0x${n.toString(16)}`, this.pc);
      if (n === 0x7E2) { this.csr.set(n, this.cycle - (v >>> 0)); return; }   // mpccr: keep the offset
      this.csr.set(n, v | 0);
    }

    step() {
      const bus = this.bus, x = this.x, pc = this.pc;
      const inst = bus.fetch(pc);
      const rd = (inst >>> 7) & 31;
      const f3 = (inst >>> 12) & 7;
      const rs1 = (inst >>> 15) & 31;
      const rs2 = (inst >>> 20) & 31;
      let npc = (pc + 4) >>> 0;

      switch (inst & 0x7f) {
        case 0x37: // LUI
          if (rd) x[rd] = inst & 0xfffff000;
          break;
        case 0x17: // AUIPC
          if (rd) x[rd] = (pc + (inst & 0xfffff000)) | 0;
          break;
        case 0x6f: { // JAL
          const imm = ((inst >> 31) << 20) | (((inst >>> 12) & 0xff) << 12) |
            (((inst >>> 20) & 1) << 11) | (((inst >>> 21) & 0x3ff) << 1);
          if (rd) x[rd] = npc | 0;
          npc = (pc + imm) >>> 0;
          break;
        }
        case 0x67: { // JALR
          if (f3) this.illegal(inst);
          const t = ((x[rs1] + (inst >> 20)) & ~1) >>> 0;
          if (rd) x[rd] = npc | 0;
          npc = t;
          break;
        }
        case 0x63: { // BRANCH
          const a = x[rs1], b = x[rs2];
          let take;
          switch (f3) {
            case 0: take = a === b; break;
            case 1: take = a !== b; break;
            case 4: take = a < b; break;
            case 5: take = a >= b; break;
            case 6: take = (a >>> 0) < (b >>> 0); break;
            case 7: take = (a >>> 0) >= (b >>> 0); break;
            default: this.illegal(inst);
          }
          if (take) {
            const imm = ((inst >> 31) << 12) | (((inst >>> 7) & 1) << 11) |
              (((inst >>> 25) & 0x3f) << 5) | (((inst >>> 8) & 0xf) << 1);
            npc = (pc + imm) >>> 0;
          }
          break;
        }
        case 0x03: { // LOAD
          const addr = (x[rs1] + (inst >> 20)) >>> 0;
          let v;
          switch (f3) {
            case 0: v = (bus.read8(addr) << 24) >> 24; break;
            case 1: v = (bus.read16(addr) << 16) >> 16; break;
            case 2: v = bus.read32(addr) | 0; break;
            case 4: v = bus.read8(addr); break;
            case 5: v = bus.read16(addr); break;
            default: this.illegal(inst);
          }
          if (rd) x[rd] = v;
          break;
        }
        case 0x23: { // STORE
          const imm = ((inst >> 25) << 5) | ((inst >>> 7) & 31);
          const addr = (x[rs1] + imm) >>> 0;
          const v = x[rs2];
          switch (f3) {
            case 0: bus.write8(addr, v & 0xff); break;
            case 1: bus.write16(addr, v & 0xffff); break;
            case 2: bus.write32(addr, v >>> 0); break;
            default: this.illegal(inst);
          }
          break;
        }
        case 0x13: { // OP-IMM
          const imm = inst >> 20;
          const a = x[rs1];
          let v;
          switch (f3) {
            case 0: v = (a + imm) | 0; break;
            case 2: v = a < imm ? 1 : 0; break;
            case 3: v = (a >>> 0) < (imm >>> 0) ? 1 : 0; break;
            case 4: v = a ^ imm; break;
            case 6: v = a | imm; break;
            case 7: v = a & imm; break;
            case 1:
              if (inst >>> 25) this.illegal(inst);
              v = a << rs2;
              break;
            case 5: {
              const f7 = inst >>> 25;
              if (f7 === 0) v = (a >>> rs2) | 0;
              else if (f7 === 0x20) v = a >> rs2;
              else this.illegal(inst);
              break;
            }
          }
          if (rd) x[rd] = v;
          break;
        }
        case 0x33: { // OP
          const f7 = inst >>> 25;
          const a = x[rs1], b = x[rs2];
          let v;
          if (f7 === 1) {
            switch (f3) {
              case 0: v = Math.imul(a, b); break;
              case 1: v = Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 32n)); break;
              case 2: v = Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b >>> 0)) >> 32n)); break;
              case 3: v = Number(BigInt.asIntN(32, (BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n)); break;
              case 4: v = b === 0 ? -1 : (a === -2147483648 && b === -1) ? a : (a / b) | 0; break;
              case 5: v = b === 0 ? -1 : Math.floor((a >>> 0) / (b >>> 0)) | 0; break;
              case 6: v = b === 0 ? a : (a === -2147483648 && b === -1) ? 0 : (a % b) | 0; break;
              case 7: v = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0; break;
            }
          } else if (f7 === 0 || f7 === 0x20) {
            if (f7 === 0x20 && f3 !== 0 && f3 !== 5) this.illegal(inst);
            switch (f3) {
              case 0: v = f7 ? (a - b) | 0 : (a + b) | 0; break;
              case 1: v = a << (b & 31); break;
              case 2: v = a < b ? 1 : 0; break;
              case 3: v = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
              case 4: v = a ^ b; break;
              case 5: v = f7 ? a >> (b & 31) : (a >>> (b & 31)) | 0; break;
              case 6: v = a | b; break;
              case 7: v = a & b; break;
            }
          } else {
            this.illegal(inst);
          }
          if (rd) x[rd] = v;
          break;
        }
        case 0x0f: // FENCE / FENCE.I
          break;
        case 0x73: { // SYSTEM
          if (f3 === 0) {
            if (inst === 0x00000073) bus.onEcall(this);
            else if (inst === 0x00100073) bus.onEbreak(this);
            else if (inst === 0x30200073) npc = this.readCsr(0x341) >>> 0; // mret
            else if (inst === 0x10500073) { /* wfi: no interrupts, acts as nop */ }
            else this.illegal(inst);
          } else if (f3 === 4) {
            this.illegal(inst);
          } else {
            const csr = inst >>> 20;
            const old = this.readCsr(csr);
            const src = (f3 & 4) ? rs1 : x[rs1];
            let nv;
            switch (f3 & 3) {
              case 1: nv = src; break;
              case 2: nv = old | src; break;
              case 3: nv = old & ~src; break;
            }
            if ((f3 & 3) === 1 || rs1 !== 0) this.writeCsr(csr, nv);
            if (rd) x[rd] = old;
          }
          break;
        }
        default:
          this.illegal(inst);
      }

      this.pc = npc;
      this.cycle++;
      this.instret++;
    }
  }

  const exportsObj = { RV32Core, SimError };
  if (typeof module !== 'undefined' && module.exports) module.exports = exportsObj;
  else Object.assign(root, exportsObj);
})(typeof window !== 'undefined' ? window : globalThis);
