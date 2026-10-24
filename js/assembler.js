/*
 * RISC-V RV32IM (+Zicsr) two-pass assembler.
 *
 * Supports labels (including numeric local labels: 1: ... 1b / 1f), the usual
 * GNU-as style directives and the standard pseudo-instructions.
 */
(function (root) {
  'use strict';

  const TEXT_BASE = 0x40380000; // ESP32-C3 internal SRAM, instruction bus (IRAM)
  const DATA_BASE = 0x3FCA0000; // ESP32-C3 internal SRAM, data bus (DRAM)

  const ABI_NAMES = [
    'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1',
    'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
    's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
    't3', 't4', 't5', 't6'
  ];
  const REGS = Object.create(null);
  ABI_NAMES.forEach((n, i) => { REGS[n] = i; REGS['x' + i] = i; });
  REGS.fp = 8;

  const CSR_NAMES = {
    cycle: 0xC00, time: 0xC01, instret: 0xC02,
    cycleh: 0xC80, timeh: 0xC81, instreth: 0xC82,
    mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305,
    mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344,
    mcycle: 0xB00, minstret: 0xB02, mcycleh: 0xB80, minstreth: 0xB82,
    mvendorid: 0xF11, marchid: 0xF12, mimpid: 0xF13, mhartid: 0xF14
  };

  const R_OPS = {
    add: [0x00, 0], sub: [0x20, 0], sll: [0x00, 1], slt: [0x00, 2], sltu: [0x00, 3],
    xor: [0x00, 4], srl: [0x00, 5], sra: [0x20, 5], or: [0x00, 6], and: [0x00, 7],
    mul: [0x01, 0], mulh: [0x01, 1], mulhsu: [0x01, 2], mulhu: [0x01, 3],
    div: [0x01, 4], divu: [0x01, 5], rem: [0x01, 6], remu: [0x01, 7]
  };
  const I_ALU = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
  const SHIFT_I = { slli: [0x00, 1], srli: [0x00, 5], srai: [0x20, 5] };
  const LOADS = { lb: 0, lh: 1, lw: 2, lbu: 4, lhu: 5 };
  const STORES = { sb: 0, sh: 1, sw: 2 };
  const BRANCH = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };
  const CSR_OPS = { csrrw: 1, csrrs: 2, csrrc: 3, csrrwi: 5, csrrsi: 6, csrrci: 7 };

  const PSEUDO = [
    'nop', 'li', 'la', 'lla', 'mv', 'not', 'neg', 'seqz', 'snez', 'sltz', 'sgtz',
    'beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz', 'bgt', 'ble', 'bgtu', 'bleu',
    'j', 'jr', 'ret', 'call', 'tail', 'csrr', 'csrw', 'csrs', 'csrc', 'csrwi', 'csrsi', 'csrci',
    'rdcycle', 'rdcycleh', 'rdtime', 'rdtimeh', 'rdinstret', 'rdinstreth'
  ];
  const BASE_OTHER = ['lui', 'auipc', 'jal', 'jalr', 'ecall', 'ebreak', 'fence', 'fence.i', 'wfi', 'mret'];

  const MNEMONICS = new Set([].concat(
    Object.keys(R_OPS), Object.keys(I_ALU), Object.keys(SHIFT_I), Object.keys(LOADS),
    Object.keys(STORES), Object.keys(BRANCH), Object.keys(CSR_OPS), BASE_OTHER, PSEUDO
  ));

  class Unresolved extends Error {}

  const hex = (v, n = 8) => (v >>> 0).toString(16).padStart(n, '0');

  // ---------------------------------------------------------------- expressions

  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      const rest = src.slice(i);
      let m;
      if ((m = /^0[xX][0-9a-fA-F_]+/.exec(rest))) {
        toks.push({ t: 'num', v: parseInt(m[0].slice(2).replace(/_/g, ''), 16) });
      } else if ((m = /^0[bB][01_]+(?![\w$.])/.exec(rest))) {
        toks.push({ t: 'num', v: parseInt(m[0].slice(2).replace(/_/g, ''), 2) });
      } else if ((m = /^(\d+)([fb])(?![\w$.])/.exec(rest))) {
        toks.push({ t: 'local', n: m[1], dir: m[2] });
      } else if ((m = /^\d[\d_]*/.exec(rest))) {
        toks.push({ t: 'num', v: parseInt(m[0].replace(/_/g, ''), 10) });
      } else if ((m = /^'(\\.|\\x[0-9a-fA-F]{1,2}|[^\\'])'/.exec(rest))) {
        toks.push({ t: 'num', v: parseString(m[1])[0] });
      } else if ((m = /^%(hi|lo)\b/.exec(rest))) {
        toks.push({ t: 'func', v: m[1] });
      } else if ((m = /^[A-Za-z_.$][\w.$]*/.exec(rest))) {
        toks.push({ t: 'sym', v: m[0] });
      } else if ((m = /^(<<|>>|[-+*/%&|^~()!])/.exec(rest))) {
        toks.push({ t: 'op', v: m[0] });
      } else {
        throw new Error(`Unexpected character '${c}' in expression`);
      }
      i += m[0].length;
    }
    return toks;
  }

  const BINOPS = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

  function evaluate(src, ctx) {
    const toks = tokenize(String(src).trim());
    if (!toks.length) throw new Error('Missing operand');
    let p = 0;

    function expect(v) {
      const t = toks[p++];
      if (!t || t.v !== v) throw new Error(`Expected '${v}' in expression '${src}'`);
    }
    function primary() {
      const t = toks[p++];
      if (!t) throw new Error(`Incomplete expression '${src}'`);
      if (t.t === 'num') return t.v;
      if (t.t === 'sym') {
        if (t.v.toLowerCase() in REGS) throw new Error(`Expected an immediate value but found register '${t.v}'`);
        return ctx.symbol(t.v);
      }
      if (t.t === 'local') return ctx.local(t.n, t.dir);
      if (t.t === 'func') {
        expect('(');
        const v = binary(1);
        expect(')');
        return t.v === 'hi' ? ((v + 0x800) >>> 12) & 0xfffff : (v << 20) >> 20;
      }
      if (t.v === '(') { const v = binary(1); expect(')'); return v; }
      throw new Error(`Unexpected '${t.v}' in expression '${src}'`);
    }
    function unary() {
      const t = toks[p];
      if (t && t.t === 'op') {
        if (t.v === '-') { p++; return -unary(); }
        if (t.v === '+') { p++; return unary(); }
        if (t.v === '~') { p++; return ~unary(); }
        if (t.v === '!') { p++; return unary() ? 0 : 1; }
      }
      return primary();
    }
    function binary(minPrec) {
      let left = unary();
      for (;;) {
        const t = toks[p];
        if (!t || t.t !== 'op' || !(t.v in BINOPS) || BINOPS[t.v] < minPrec) return left;
        p++;
        const right = binary(BINOPS[t.v] + 1);
        switch (t.v) {
          case '+': left = left + right; break;
          case '-': left = left - right; break;
          case '*': left = left * right; break;
          case '/': if (!right) throw new Error('Division by zero'); left = Math.trunc(left / right); break;
          case '%': if (!right) throw new Error('Division by zero'); left = left % right; break;
          case '<<': left = left * Math.pow(2, right & 63); break;
          case '>>': left = Math.floor(left / Math.pow(2, right & 63)); break;
          case '&': left = (left & right) >>> 0; break;
          case '|': left = (left | right) >>> 0; break;
          case '^': left = (left ^ right) >>> 0; break;
        }
      }
    }
    const v = binary(1);
    if (p < toks.length) throw new Error(`Unexpected '${toks[p].v !== undefined ? toks[p].v : toks[p].n}' in expression '${src}'`);
    return v;
  }

  // Parse the inside of a string literal (without quotes) into byte values.
  function parseString(body) {
    const out = [];
    for (let i = 0; i < body.length; i++) {
      let c = body[i];
      if (c !== '\\') {
        const code = body.charCodeAt(i);
        if (code < 0x80) out.push(code);
        else for (const b of new TextEncoder().encode(c)) out.push(b);
        continue;
      }
      c = body[++i];
      switch (c) {
        case 'n': out.push(10); break;
        case 't': out.push(9); break;
        case 'r': out.push(13); break;
        case '0': out.push(0); break;
        case 'a': out.push(7); break;
        case 'b': out.push(8); break;
        case 'f': out.push(12); break;
        case 'v': out.push(11); break;
        case 'e': out.push(27); break;
        case 'x': {
          const m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1));
          if (!m) throw new Error('Invalid \\x escape');
          out.push(parseInt(m[0], 16));
          i += m[0].length;
          break;
        }
        default: out.push(c.charCodeAt(0));
      }
    }
    return out;
  }

  function parseStringList(args) {
    const bytes = [];
    for (const a of args) {
      const m = /^"((?:\\.|[^"\\])*)"$/.exec(a.trim());
      if (!m) throw new Error(`Expected a string literal, found '${a}'`);
      bytes.push(...parseString(m[1]));
    }
    return bytes;
  }

  // ---------------------------------------------------------------- parsing

  function stripComment(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '"') { q = c; continue; }
      if (c === "'" && /^'(\\.|[^\\'])'/.test(s.slice(i))) { q = c; continue; }
      if (c === '#' || c === ';') return s.slice(0, i);
      if (c === '/' && s[i + 1] === '/') return s.slice(0, i);
    }
    return s;
  }

  function splitArgs(s) {
    const out = [];
    let depth = 0, q = null, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        cur += c;
        if (c === '\\') { cur += s[++i] || ''; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim() !== '' || out.length) out.push(cur.trim());
    return out;
  }

  function parseSource(src) {
    // Blank out /* block comments */ while keeping line numbers intact.
    src = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
    const lines = src.split(/\r?\n/);
    const stmts = [];
    lines.forEach((raw, idx) => {
      let s = stripComment(raw);
      const labels = [];
      let m;
      while ((m = /^\s*([A-Za-z_.$][\w.$]*|\d+)\s*:(?!:)/.exec(s))) {
        labels.push(m[1]);
        s = s.slice(m[0].length);
      }
      s = s.trim();
      let op = null, args = [];
      if ((m = /^([A-Za-z_.$][\w.$]*)\s*=\s*(.+)$/.exec(s))) {
        op = '.equ'; args = [m[1], m[2]];
      } else if (s) {
        m = /^(\S+)\s*(.*)$/.exec(s);
        op = m[1].toLowerCase();
        args = splitArgs(m[2]);
      }
      stmts.push({ line: idx + 1, src: raw, labels, op, args });
    });
    return stmts;
  }

  // ---------------------------------------------------------------- encoding helpers

  function reg(s) {
    const r = REGS[String(s).trim().toLowerCase()];
    if (r === undefined) throw new Error(`Invalid register '${s}'`);
    return r;
  }
  const isMem = s => /\(\s*[\w$]+\s*\)\s*$/.test(s) && /^[^"]*\(/.test(s);

  function checkRange(v, lo, hi, what) {
    if (v < lo || v > hi) throw new Error(`${what} ${v} out of range [${lo}, ${hi}]`);
  }
  const s32 = v => v | 0;

  function encR(f7, rs2, rs1, f3, rd, opc) {
    return ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc) >>> 0;
  }
  function encI(imm, rs1, f3, rd, opc) {
    imm = s32(imm);
    checkRange(imm, -2048, 2047, 'Immediate');
    return (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc) >>> 0;
  }
  function encS(imm, rs2, rs1, f3) {
    imm = s32(imm);
    checkRange(imm, -2048, 2047, 'Offset');
    return ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | 0x23) >>> 0;
  }
  function encB(off, rs2, rs1, f3) {
    off = s32(off);
    if (off & 1) throw new Error('Branch target is not 2-byte aligned');
    checkRange(off, -4096, 4094, 'Branch offset');
    return ((((off >> 12) & 1) << 31) | (((off >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) |
      (f3 << 12) | (((off >> 1) & 0xf) << 8) | (((off >> 11) & 1) << 7) | 0x63) >>> 0;
  }
  function encU(imm20, rd, opc) {
    if (imm20 < -0x80000 || imm20 > 0xfffff) throw new Error(`Upper immediate ${imm20} out of range [0, 0xFFFFF]`);
    return (((imm20 & 0xfffff) << 12) | (rd << 7) | opc) >>> 0;
  }
  function encJ(off, rd) {
    off = s32(off);
    if (off & 1) throw new Error('Jump target is not 2-byte aligned');
    checkRange(off, -0x100000, 0xffffe, 'Jump offset');
    return ((((off >> 20) & 1) << 31) | (((off >> 1) & 0x3ff) << 21) | (((off >> 11) & 1) << 20) |
      (((off >> 12) & 0xff) << 12) | (rd << 7) | 0x6f) >>> 0;
  }
  function encCsr(csr, rs1, f3, rd) {
    return (((csr & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | 0x73) >>> 0;
  }
  function hiLo(v) {
    v = s32(v);
    const hi = ((v + 0x800) >>> 12) & 0xfffff;
    const lo = (v << 20) >> 20;
    return { hi, lo };
  }

  // Number of bytes a statement will occupy (pass 1).
  function instrSize(op, a, ctx) {
    switch (op) {
      case 'la': case 'lla': return 8;
      case 'li': {
        if (a.length !== 2) return 4;
        try {
          const v = s32(evaluate(a[1], ctx));
          if (v >= -2048 && v <= 2047) return 4;
          return (v & 0xfff) === 0 ? 4 : 8;
        } catch (e) {
          if (e instanceof Unresolved) return 8;
          throw e;
        }
      }
      case 'lb': case 'lh': case 'lw': case 'lbu': case 'lhu':
        return a.length === 2 && !isMem(a[1]) ? 8 : 4;
      case 'sb': case 'sh': case 'sw':
        return a.length === 3 ? 8 : 4;
      default: return 4;
    }
  }

  function encode(op, a, pc, ctx, size) {
    const E = s => evaluate(s, ctx);
    const need = n => {
      if (a.length !== n) throw new Error(`'${op}' expects ${n} operand${n === 1 ? '' : 's'}, got ${a.length}`);
    };
    const mem = s => {
      const m = /^(.*)\(\s*([\w$]+)\s*\)\s*$/.exec(s);
      if (!m) throw new Error(`Expected memory operand 'offset(reg)', found '${s}'`);
      return { off: m[1].trim() ? E(m[1]) : 0, base: reg(m[2]) };
    };
    const csr = s => {
      const n = CSR_NAMES[s.trim().toLowerCase()];
      if (n !== undefined) return n;
      const v = E(s);
      checkRange(v, 0, 4095, 'CSR number');
      return v;
    };
    const target = s => E(s) - pc;

    if (op in R_OPS) { need(3); const [f7, f3] = R_OPS[op]; return [encR(f7, reg(a[2]), reg(a[1]), f3, reg(a[0]), 0x33)]; }
    if (op in I_ALU) { need(3); return [encI(E(a[2]), reg(a[1]), I_ALU[op], reg(a[0]), 0x13)]; }
    if (op in SHIFT_I) {
      need(3);
      const sh = E(a[2]);
      checkRange(sh, 0, 31, 'Shift amount');
      const [f7, f3] = SHIFT_I[op];
      return [encR(f7, sh, reg(a[1]), f3, reg(a[0]), 0x13)];
    }
    if (op in LOADS) {
      need(2);
      const rd = reg(a[0]);
      if (!isMem(a[1])) { // lw rd, symbol
        const { hi, lo } = hiLo(target(a[1]));
        return [encU(hi, rd, 0x17), encI(lo, rd, LOADS[op], rd, 0x03)];
      }
      const { off, base } = mem(a[1]);
      return [encI(off, base, LOADS[op], rd, 0x03)];
    }
    if (op in STORES) {
      if (a.length === 3) { // sw rs, symbol, rt
        const rt = reg(a[2]);
        const { hi, lo } = hiLo(target(a[1]));
        return [encU(hi, rt, 0x17), encS(lo, reg(a[0]), rt, STORES[op])];
      }
      need(2);
      const { off, base } = mem(a[1]);
      return [encS(off, reg(a[0]), base, STORES[op])];
    }
    if (op in BRANCH) { need(3); return [encB(target(a[2]), reg(a[1]), reg(a[0]), BRANCH[op])]; }
    if (op in CSR_OPS) {
      need(3);
      const f3 = CSR_OPS[op];
      let src;
      if (f3 & 4) { src = E(a[2]); checkRange(src, 0, 31, 'CSR immediate'); } else src = reg(a[2]);
      return [encCsr(csr(a[1]), src, f3, reg(a[0]))];
    }

    switch (op) {
      case 'lui': need(2); return [encU(E(a[1]), reg(a[0]), 0x37)];
      case 'auipc': need(2); return [encU(E(a[1]), reg(a[0]), 0x17)];
      case 'jal':
        if (a.length === 1) return [encJ(target(a[0]), 1)];
        need(2); return [encJ(target(a[1]), reg(a[0]))];
      case 'jalr':
        if (a.length === 1) {
          if (isMem(a[0])) { const { off, base } = mem(a[0]); return [encI(off, base, 0, 1, 0x67)]; }
          return [encI(0, reg(a[0]), 0, 1, 0x67)];
        }
        if (a.length === 2) {
          if (isMem(a[1])) { const { off, base } = mem(a[1]); return [encI(off, base, 0, reg(a[0]), 0x67)]; }
          return [encI(0, reg(a[1]), 0, reg(a[0]), 0x67)];
        }
        need(3); return [encI(E(a[2]), reg(a[1]), 0, reg(a[0]), 0x67)];
      case 'ecall': need(0); return [0x00000073];
      case 'ebreak': need(0); return [0x00100073];
      case 'fence': return [0x0ff0000f];
      case 'fence.i': need(0); return [0x0000100f];
      case 'wfi': need(0); return [0x10500073];
      case 'mret': need(0); return [0x30200073];

      // ---- pseudo-instructions
      case 'nop': need(0); return [0x00000013];
      case 'li': {
        need(2);
        const rd = reg(a[0]);
        const v = s32(E(a[1]));
        const { hi, lo } = hiLo(v);
        if (size === 4) {
          if (v >= -2048 && v <= 2047) return [encI(v, 0, 0, rd, 0x13)];
          if (lo === 0) return [encU(hi, rd, 0x37)];
          throw new Error('Value of li changed between passes');
        }
        return [encU(hi, rd, 0x37), encI(lo, rd, 0, rd, 0x13)];
      }
      case 'la': case 'lla': {
        need(2);
        const rd = reg(a[0]);
        const { hi, lo } = hiLo(target(a[1]));
        return [encU(hi, rd, 0x17), encI(lo, rd, 0, rd, 0x13)];
      }
      case 'mv': need(2); return [encI(0, reg(a[1]), 0, reg(a[0]), 0x13)];
      case 'not': need(2); return [encI(-1, reg(a[1]), 4, reg(a[0]), 0x13)];
      case 'neg': need(2); return [encR(0x20, reg(a[1]), 0, 0, reg(a[0]), 0x33)];
      case 'seqz': need(2); return [encI(1, reg(a[1]), 3, reg(a[0]), 0x13)];
      case 'snez': need(2); return [encR(0, reg(a[1]), 0, 3, reg(a[0]), 0x33)];
      case 'sltz': need(2); return [encR(0, 0, reg(a[1]), 2, reg(a[0]), 0x33)];
      case 'sgtz': need(2); return [encR(0, reg(a[1]), 0, 2, reg(a[0]), 0x33)];
      case 'beqz': need(2); return [encB(target(a[1]), 0, reg(a[0]), 0)];
      case 'bnez': need(2); return [encB(target(a[1]), 0, reg(a[0]), 1)];
      case 'blez': need(2); return [encB(target(a[1]), reg(a[0]), 0, 5)];
      case 'bgez': need(2); return [encB(target(a[1]), 0, reg(a[0]), 5)];
      case 'bltz': need(2); return [encB(target(a[1]), 0, reg(a[0]), 4)];
      case 'bgtz': need(2); return [encB(target(a[1]), reg(a[0]), 0, 4)];
      case 'bgt': need(3); return [encB(target(a[2]), reg(a[0]), reg(a[1]), 4)];
      case 'ble': need(3); return [encB(target(a[2]), reg(a[0]), reg(a[1]), 5)];
      case 'bgtu': need(3); return [encB(target(a[2]), reg(a[0]), reg(a[1]), 6)];
      case 'bleu': need(3); return [encB(target(a[2]), reg(a[0]), reg(a[1]), 7)];
      case 'j': need(1); return [encJ(target(a[0]), 0)];
      case 'jr': need(1); return [encI(0, reg(a[0]), 0, 0, 0x67)];
      case 'ret': need(0); return [0x00008067];
      case 'call': need(1); return [encJ(target(a[0]), 1)];
      case 'tail': need(1); return [encJ(target(a[0]), 0)];
      case 'csrr': need(2); return [encCsr(csr(a[1]), 0, 2, reg(a[0]))];
      case 'csrw': need(2); return [encCsr(csr(a[0]), reg(a[1]), 1, 0)];
      case 'csrs': need(2); return [encCsr(csr(a[0]), reg(a[1]), 2, 0)];
      case 'csrc': need(2); return [encCsr(csr(a[0]), reg(a[1]), 3, 0)];
      case 'csrwi': case 'csrsi': case 'csrci': {
        need(2);
        const v = E(a[1]);
        checkRange(v, 0, 31, 'CSR immediate');
        return [encCsr(csr(a[0]), v, { csrwi: 5, csrsi: 6, csrci: 7 }[op], 0)];
      }
      case 'rdcycle': need(1); return [encCsr(0xC00, 0, 2, reg(a[0]))];
      case 'rdcycleh': need(1); return [encCsr(0xC80, 0, 2, reg(a[0]))];
      case 'rdtime': need(1); return [encCsr(0xC01, 0, 2, reg(a[0]))];
      case 'rdtimeh': need(1); return [encCsr(0xC81, 0, 2, reg(a[0]))];
      case 'rdinstret': need(1); return [encCsr(0xC02, 0, 2, reg(a[0]))];
      case 'rdinstreth': need(1); return [encCsr(0xC82, 0, 2, reg(a[0]))];
    }
    throw new Error(`Unknown instruction '${op}'`);
  }

  // ---------------------------------------------------------------- assembler

  const IGNORED_DIRECTIVES = new Set([
    '.globl', '.global', '.local', '.type', '.size', '.file', '.ident', '.option', '.attribute',
    '.extern', '.weak', '.func', '.endfunc', '.end', '.cfi_startproc', '.cfi_endproc', '.hidden'
  ]);

  // opts.textBase / opts.dataBase move the sections (used for the hardware runtime).
  function assemble(source, opts = {}) {
    const textBase = opts.textBase !== undefined ? opts.textBase >>> 0 : TEXT_BASE;
    const dataBase = opts.dataBase !== undefined ? opts.dataBase >>> 0 : DATA_BASE;
    const stmts = parseSource(source);
    const errors = [];
    const labels = new Map();
    const equs = new Map();
    const locals = new Map();
    const evaluating = new Set();

    function evalEqu(name, strict) {
      const e = equs.get(name);
      if (e.value !== undefined) return e.value;
      if (evaluating.has(name)) throw new Error(`Circular definition of '${name}'`);
      evaluating.add(name);
      try {
        const v = evaluate(e.expr, makeCtx(e.pos, strict));
        e.value = v;
        return v;
      } finally {
        evaluating.delete(name);
      }
    }

    function makeCtx(pos, strict) {
      return {
        symbol(name) {
          if (labels.has(name)) return labels.get(name);
          if (equs.has(name)) return evalEqu(name, strict);
          if (strict) throw new Error(`Undefined symbol '${name}'`);
          throw new Unresolved(name);
        },
        local(n, dir) {
          const defs = locals.get(n) || [];
          if (dir === 'b') {
            for (let i = defs.length - 1; i >= 0; i--) if (defs[i].pos < pos) return defs[i].addr;
          } else {
            for (const d of defs) if (d.pos > pos) return d.addr;
          }
          if (strict) throw new Error(`Undefined local label '${n}${dir}'`);
          throw new Unresolved(n + dir);
        }
      };
    }

    const pcs = { text: textBase, data: dataBase };
    let cur = 'text';

    // ---- pass 1: lay out sections and define symbols
    stmts.forEach((st, i) => {
      try {
        const isInstr = st.op && st.op[0] !== '.';
        if (isInstr && pcs[cur] % 4) pcs[cur] += 4 - (pcs[cur] % 4);
        st.addr = pcs[cur];
        st.section = cur;
        st.size = 0;
        for (const l of st.labels) {
          if (/^\d+$/.test(l)) {
            if (!locals.has(l)) locals.set(l, []);
            locals.get(l).push({ pos: i - 0.5, addr: pcs[cur] });
          } else {
            if (labels.has(l) || equs.has(l)) throw new Error(`Duplicate symbol '${l}'`);
            if (l.toLowerCase() in REGS) throw new Error(`'${l}' is a register name and cannot be used as a label`);
            labels.set(l, pcs[cur]);
          }
        }
        if (!st.op) return;
        const ctx = makeCtx(i, false);
        const a = st.args;
        if (isInstr) {
          st.size = instrSize(st.op, a, ctx);
        } else {
          switch (st.op) {
            case '.text': cur = 'text'; break;
            case '.data': case '.bss': case '.rodata': case '.sdata': case '.sbss': cur = 'data'; break;
            case '.section': cur = /^\.text/.test(a[0] || '') ? 'text' : 'data'; break;
            case '.equ': case '.set': case '.eqv': {   // .eqv: the RARS / MARS spelling of .equ
              if (a.length !== 2) throw new Error(`${st.op} expects: ${st.op} NAME, value`);
              const name = a[0];
              if (!/^[A-Za-z_.$][\w.$]*$/.test(name)) throw new Error(`Invalid symbol name '${name}'`);
              if (labels.has(name)) throw new Error(`Duplicate symbol '${name}'`);
              if (equs.has(name) && st.op !== '.set') throw new Error(`Duplicate symbol '${name}'`);
              equs.set(name, { expr: a[1], pos: i });
              break;
            }
            case '.word': case '.long': case '.4byte': st.size = 4 * a.length; break;
            case '.half': case '.short': case '.2byte': st.size = 2 * a.length; break;
            case '.byte': case '.1byte': st.size = a.length; break;
            case '.ascii': st.size = parseStringList(a).length; break;
            case '.asciz': case '.string': st.size = a.reduce((n, s) => n + parseStringList([s]).length + 1, 0); break;
            case '.space': case '.zero': case '.skip': {
              if (!a.length) throw new Error(`${st.op} expects a size`);
              let n;
              try { n = evaluate(a[0], ctx); } catch (e) {
                if (e instanceof Unresolved) throw new Error(`${st.op} size must be a constant defined earlier`);
                throw e;
              }
              checkRange(n, 0, 0x40000, 'Size');
              st.size = n;
              break;
            }
            case '.align': case '.p2align': case '.balign': {
              const n = evaluate(a[0] || '2', ctx);
              const align = st.op === '.balign' ? n : Math.pow(2, n);
              if (align < 1 || align > 4096 || (align & (align - 1))) throw new Error(`Invalid alignment ${align}`);
              st.size = (align - (pcs[cur] % align)) % align;
              break;
            }
            default:
              if (!IGNORED_DIRECTIVES.has(st.op)) throw new Error(`Unknown directive '${st.op}'`);
          }
        }
        pcs[cur] += st.size;
      } catch (e) {
        errors.push({ line: st.line, message: e.message });
        st.failed = true;
      }
    });

    const text = new Uint8Array(pcs.text - textBase);
    const data = new Uint8Array(pcs.data - dataBase);
    const listing = [];
    const addrToLine = new Map();
    const lineToAddr = new Map();

    function put(section, addr, bytes) {
      const buf = section === 'text' ? text : data;
      buf.set(bytes, addr - (section === 'text' ? textBase : dataBase));
    }
    const le = (v, n) => { const b = []; for (let k = 0; k < n; k++) b.push((v >>> (8 * k)) & 0xff); return b; };

    // ---- pass 2: encode
    stmts.forEach((st, i) => {
      if (!st.op || st.failed) return;
      try {
        const ctx = makeCtx(i, true);
        const a = st.args;
        if (st.op[0] !== '.') {
          const words = encode(st.op, a, st.addr, ctx, st.size);
          if (words.length * 4 !== st.size) throw new Error('Internal error: instruction size mismatch');
          const bytes = [];
          words.forEach((w, k) => {
            bytes.push(...le(w, 4));
            if (st.section === 'text') addrToLine.set(st.addr + 4 * k, st.line);
          });
          put(st.section, st.addr, bytes);
          if (!lineToAddr.has(st.line)) lineToAddr.set(st.line, st.addr);
          listing.push({ addr: st.addr, words, line: st.line, src: st.src, section: st.section });
          return;
        }
        let bytes = null;
        switch (st.op) {
          case '.word': case '.long': case '.4byte':
            bytes = [];
            for (const x of a) { const v = evaluate(x, ctx); checkRange(v, -0x80000000, 0xffffffff, 'Value'); bytes.push(...le(v, 4)); }
            break;
          case '.half': case '.short': case '.2byte':
            bytes = [];
            for (const x of a) { const v = evaluate(x, ctx); checkRange(v, -0x8000, 0xffff, 'Value'); bytes.push(...le(v, 2)); }
            break;
          case '.byte': case '.1byte':
            bytes = a.map(x => { const v = evaluate(x, ctx); checkRange(v, -128, 255, 'Value'); return v & 0xff; });
            break;
          case '.ascii': bytes = parseStringList(a); break;
          case '.asciz': case '.string': bytes = []; for (const s of a) bytes.push(...parseStringList([s]), 0); break;
          case '.space': case '.zero': case '.skip': {
            const fill = a.length > 1 ? evaluate(a[1], ctx) & 0xff : 0;
            bytes = new Array(st.size).fill(fill);
            break;
          }
          case '.align': case '.p2align': case '.balign':
            if (st.size) {
              bytes = [];
              const useNop = st.section === 'text' && st.addr % 4 === 0 && st.size % 4 === 0;
              for (let k = 0; k < st.size; k += useNop ? 4 : 1) bytes.push(...(useNop ? le(0x13, 4) : [0]));
            }
            break;
        }
        if (bytes && bytes.length) {
          put(st.section, st.addr, bytes);
          listing.push({ addr: st.addr, bytes, line: st.line, src: st.src, section: st.section });
        }
      } catch (e) {
        errors.push({ line: st.line, message: e.message });
      }
    });

    errors.sort((x, y) => x.line - y.line);
    const symbols = {};
    for (const [k, v] of labels) symbols[k] = v >>> 0;
    const constants = {};
    for (const [k, e] of equs) { try { constants[k] = evalEqu(k, true); } catch (_) { /* reported elsewhere */ } }

    let entry = textBase;
    if (labels.has('_start')) entry = labels.get('_start');
    else if (labels.has('main')) entry = labels.get('main');

    return {
      ok: errors.length === 0,
      errors,
      text: { base: textBase, bytes: text },
      data: { base: dataBase, bytes: data },
      entry: entry >>> 0,
      symbols,
      constants,
      listing,
      addrToLine,
      lineToAddr
    };
  }

  // ---------------------------------------------------------------- disassembler

  const CSR_BY_NUM = {};
  for (const [k, v] of Object.entries(CSR_NAMES)) if (!(v in CSR_BY_NUM)) CSR_BY_NUM[v] = k;
  const invert = o => { const r = {}; for (const [k, v] of Object.entries(o)) r[Array.isArray(v) ? v.join(',') : v] = k; return r; };
  const R_BY = invert(R_OPS), I_ALU_BY = invert(I_ALU), SHIFT_BY = invert(SHIFT_I);
  const LOAD_BY = invert(LOADS), STORE_BY = invert(STORES), BRANCH_BY = invert(BRANCH), CSR_BY = invert(CSR_OPS);

  /**
   * Decode one 32-bit instruction into its base (non-pseudo) form, e.g. 'addi a0, zero, 5'.
   * addr resolves PC-relative targets; labels (address -> name) annotates them.
   */
  function disassemble(w, addr, labels) {
    w >>>= 0;
    const op = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, f7 = w >>> 25;
    const r = n => ABI_NAMES[n];
    const immI = w >> 20;
    const immS = ((w >> 25) << 5) | ((w >>> 7) & 31);
    const immB = ((w >> 31) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1);
    const immJ = ((w >> 31) << 20) | (((w >>> 12) & 0xff) << 12) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1);
    const target = off => {
      const t = (addr + off) >>> 0;
      const name = labels && labels.get(t);
      return '0x' + hex(t) + (name ? ` <${name}>` : '');
    };
    switch (op) {
      case 0x37: return `lui ${r(rd)}, 0x${(w >>> 12).toString(16)}`;
      case 0x17: return `auipc ${r(rd)}, 0x${(w >>> 12).toString(16)}`;
      case 0x6f: return `jal ${r(rd)}, ${target(immJ)}`;
      case 0x67: if (!f3) return `jalr ${r(rd)}, ${immI}(${r(rs1)})`; break;
      case 0x63: if (f3 in BRANCH_BY) return `${BRANCH_BY[f3]} ${r(rs1)}, ${r(rs2)}, ${target(immB)}`; break;
      case 0x03: if (f3 in LOAD_BY) return `${LOAD_BY[f3]} ${r(rd)}, ${immI}(${r(rs1)})`; break;
      case 0x23: if (f3 in STORE_BY) return `${STORE_BY[f3]} ${r(rs2)}, ${immS}(${r(rs1)})`; break;
      case 0x13:
        if (f3 === 1 || f3 === 5) {
          const name = SHIFT_BY[`${f7},${f3}`];
          if (name) return `${name} ${r(rd)}, ${r(rs1)}, ${rs2}`;
          break;
        }
        return `${I_ALU_BY[f3]} ${r(rd)}, ${r(rs1)}, ${immI}`;
      case 0x33: { const name = R_BY[`${f7},${f3}`]; if (name) return `${name} ${r(rd)}, ${r(rs1)}, ${r(rs2)}`; break; }
      case 0x0f: return f3 === 1 ? 'fence.i' : 'fence';
      case 0x73: {
        if (f3 === 0) {
          const sys = { 0x00000073: 'ecall', 0x00100073: 'ebreak', 0x10500073: 'wfi', 0x30200073: 'mret' }[w];
          if (sys) return sys;
          break;
        }
        const name = CSR_BY[f3];
        if (!name) break;
        const csr = w >>> 20, cn = CSR_BY_NUM[csr] || '0x' + csr.toString(16);
        return `${name} ${r(rd)}, ${cn}, ${f3 & 4 ? rs1 : r(rs1)}`;
      }
    }
    return '(unknown)';
  }

  const RVAsm = {
    assemble, disassemble, evaluate, TEXT_BASE, DATA_BASE, REGS, ABI_NAMES, CSR_NAMES, MNEMONICS, hex
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = RVAsm;
  else root.RVAsm = RVAsm;
})(typeof window !== 'undefined' ? window : globalThis);
