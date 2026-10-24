/* Run with: node tests/run-tests.js */
'use strict';
const RVAsm = require('../js/assembler.js');
const { ESP32C3 } = require('../js/esp32c3.js');
const { EXAMPLES, BOARD_EXAMPLES } = require('../js/examples.js');

let failed = 0, passed = 0;
function check(name, cond, info) {
  if (cond) passed++;
  else { failed++; console.log('FAIL:', name, info !== undefined ? info : ''); }
}
const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

// ---- encodings (reference values from GNU as)
const ENC = [
  ['addi a0, zero, 5', 0x00500513],
  ['add a0, a1, a2', 0x00c58533],
  ['sub t0, t1, t2', 0x407302b3],
  ['lw a0, 4(sp)', 0x00412503],
  ['sw ra, 12(sp)', 0x00112623],
  ['lui a0, 0x60004', 0x60004537],
  ['mul a0, a1, a2', 0x02c58533],
  ['divu a0, a1, a2', 0x02c5d533],
  ['ecall', 0x00000073],
  ['ebreak', 0x00100073],
  ['slli a0, a0, 3', 0x00351513],
  ['srai a0, a0, 3', 0x40355513],
  ['csrr a0, mcycle', 0xb0002573],
  ['ret', 0x00008067],
  ['nop', 0x00000013],
  ['mv a1, a0', 0x00050593],
  ['not a0, a1', 0xfff5c513],
  ['neg a0, a1', 0x40b00533],
  ['sb a0, -1(t0)', 0xfea28fa3],
  ['lbu t1, 0(t0)', 0x0002c303],
  ['andi t2, t2, -256', 0xf003f393],
];
for (const [src, want] of ENC) {
  const r = RVAsm.assemble(src);
  const got = r.ok ? new DataView(r.text.bytes.buffer).getUint32(0, true) : null;
  check(`encode "${src}"`, got === want, r.ok ? `${hex(got)} != ${hex(want)}` : JSON.stringify(r.errors));
}

// branches / jumps relative
{
  const r = RVAsm.assemble('start: beq a0, a1, tgt\n nop\ntgt: jal ra, start\n j tgt\n 1: bnez a0, 1b\n');
  const dv = new DataView(r.text.bytes.buffer);
  check('beq +8', dv.getUint32(0, true) === 0x00b50463, hex(dv.getUint32(0, true)));
  check('jal -8', dv.getUint32(8, true) === 0xff9ff0ef, hex(dv.getUint32(8, true)));
  check('j -4', dv.getUint32(12, true) === 0xffdff06f, hex(dv.getUint32(12, true)));
  check('bnez self', dv.getUint32(16, true) === 0x00051063, hex(dv.getUint32(16, true)));
}

// ---- disassembler: pseudo-instructions show their base instructions
{
  const r = RVAsm.assemble('main: li a0, 0x12345678\n mv a1, a0\n beqz a0, main\n ret\n csrr a0, mcycle\n');
  const labels = new Map(Object.entries(r.symbols).map(([k, v]) => [v, k]));
  const got = [];
  for (const it of r.listing) it.words.forEach((w, k) => got.push(RVAsm.disassemble(w, it.addr + 4 * k, labels)));
  const want = ['lui a0, 0x12345', 'addi a0, a0, 1656', 'addi a1, a0, 0', 'beq a0, zero, 0x40380000 <main>',
    'jalr zero, 0(ra)', 'csrrs a0, mcycle, zero'];
  check('disassemble pseudo expansions', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
// round trip: every non-PC-relative instruction of every example re-assembles to the same word
{
  const PC_REL = new Set([0x6f, 0x63, 0x17]);
  let bad = [];
  for (const ex of EXAMPLES) {
    const r = RVAsm.assemble(ex.code);
    for (const it of r.listing) (it.words || []).forEach((w, k) => {
      const d = RVAsm.disassemble(w, it.addr + 4 * k);
      if (d === '(unknown)') { bad.push(`${ex.id}: ${hex(w)}`); return; }
      if (PC_REL.has(w & 0x7f)) return;
      const back = RVAsm.assemble(d);
      const w2 = back.ok ? new DataView(back.text.bytes.buffer).getUint32(0, true) : null;
      if (w2 !== w) bad.push(`${ex.id}: ${d} ${hex(w)} -> ${w2 === null ? JSON.stringify(back.errors) : hex(w2)}`);
    });
  }
  check('disassemble round trip (examples)', bad.length === 0, bad.slice(0, 5).join('; '));
}

// ---- errors
{
  const r = RVAsm.assemble('foo a0\naddi a0, a0, 5000\nlw a0, 0(q9)\nj nowhere\n');
  check('errors reported', r.errors.length === 4, JSON.stringify(r.errors));
  check('error lines', r.errors.map(e => e.line).join(',') === '1,2,3,4', JSON.stringify(r.errors));
}

// ---- run a program to completion
function runProgram(src, maxCycles = 5e6, setup) {
  const r = RVAsm.assemble(src);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const m = new ESP32C3();
  m.load(r);
  if (setup) setup(m);
  const res = m.run(maxCycles, null, Infinity);
  return { m, res, out: Buffer.from(m.tx).toString() };
}

{
  const { m, res, out } = runProgram(`
    .data
v:  .word 7
msg: .asciz "ok"
    .text
main:
    lw   a0, v          # global load pseudo
    li   a1, 6
    mul  a0, a0, a1     # 42
    li   t0, -7
    li   t1, 2
    div  t2, t0, t1     # -3
    rem  t3, t0, t1     # -1
    li   t4, 0x12345678
    li   t5, 0x80000000
    srai t5, t5, 4
    li   a7, 1
    ecall
    li   a0, ' '
    li   a7, 11
    ecall
    la   a0, msg
    li   a7, 4
    ecall
    li   a0, 3
    li   a7, 93
    ecall
`);
  check('run halts', res === 'halt', res);
  check('print output', out === '42 ok', JSON.stringify(out));
  check('div', m.core.x[7] === -3);
  check('rem', m.core.x[28] === -1);
  check('li big', m.core.x[29] === 0x12345678);
  check('srai', m.core.x[30] === (0xf8000000 | 0), hex(m.core.x[30]));
  check('exit message', m.haltMessage === 'Program exited with code 3', m.haltMessage);
}

// recursion with stack (factorial)
{
  const { m, res } = runProgram(`
main:   li a0, 10
        call fact
        mv s0, a0
        li a7, 10
        ecall
fact:   addi sp, sp, -8
        sw ra, 4(sp)
        sw a0, 0(sp)
        li t0, 1
        ble a0, t0, 1f
        addi a0, a0, -1
        call fact
        lw t1, 0(sp)
        mul a0, a0, t1
        j 2f
1:      li a0, 1
2:      lw ra, 4(sp)
        addi sp, sp, 8
        ret
`);
  check('factorial', res === 'halt' && m.core.x[8] === 3628800, m.core.x[8]);
}

// faults
{
  const { m, res } = runProgram('main: li t0, 0x10\n lw a0, 0(t0)\n');
  check('load fault', res === 'error' && /Load access fault/.test(m.error.message), m.error && m.error.message);
}

{ // .eqv (RARS / MARS) is .equ: a constant that can't be redefined
  const r = RVAsm.assemble('.eqv LED, 2\n.equ MASK, 1 << LED\nmain: li a0, MASK\n');
  const dup = RVAsm.assemble('.eqv A, 1\n.eqv A, 2\n');
  check('.eqv defines a constant', r.ok && r.constants.MASK === 4 && !dup.ok && /Duplicate/.test(dup.errors[0].message), JSON.stringify([r.errors, r.constants]));
}

// ---- examples assemble + behave
for (const ex of EXAMPLES) {
  const r = RVAsm.assemble(ex.code);
  check(`example ${ex.id} assembles`, r.ok, JSON.stringify(r.errors));
}

function exampleMachine(id) {
  const ex = EXAMPLES.find(e => e.id === id);
  const m = new ESP32C3();
  m.load(RVAsm.assemble(ex.code));
  return m;
}
const CPU_HZ = ESP32C3.CPU_HZ;

{ // blink: LED on GPIO2 toggles with 500 ms period
  const m = exampleMachine('blink');
  m.run(CPU_HZ * 0.25, null, Infinity);
  const on = (m.levels() >> 2) & 1;
  m.run(CPU_HZ * 0.75, null, Infinity);
  const off = (m.levels() >> 2) & 1;
  m.run(CPU_HZ * 1.25, null, Infinity);
  const on2 = (m.levels() >> 2) & 1;
  check('blink timing', on === 1 && off === 0 && on2 === 1, [on, off, on2]);
}

{ // button example
  const m = exampleMachine('button');
  m.setExternal({});               // released: floating, the program enables the pull-up
  m.run(100000, null, Infinity);
  const off = (m.levels() >> 2) & 1;
  m.setExternal({ force: 1 << 4, value: 0 });   // pressed: pin connected to GND
  m.run(200000, null, Infinity);
  const on = (m.levels() >> 2) & 1;
  check('button example', off === 0 && on === 1, [off, on]);
}

{ // 7-seg: after 1.5 s digit 1 is shown
  const m = exampleMachine('sevenseg');
  m.run(CPU_HZ * 0.5, null, Infinity);
  const d0 = m.levels() & 0xff;
  m.run(CPU_HZ * 1.5, null, Infinity);
  const d1 = m.levels() & 0xff;
  check('7-seg digits', d0 === 0x3f && d1 === 0x06, [hex(d0), hex(d1)]);
  // XIAO wiring: a..f on GPIO2..7, g on GPIO10, dp on GPIO20 (switched from U0RXD to GPIO)
  const x = exampleMachine('sevenseg-xiao');
  x.run(CPU_HZ * 2.5, null, Infinity);
  const two = x.levels() & ((0x3F << 2) | (1 << 10) | (1 << 20));                  // 2 = a, b, d, e, g
  check('7-seg digits on the XIAO pins', two === ((0x1B << 2) | (1 << 10)) && x.pinFunction(20) === 'GPIO20', hex(two));
}

{ // Examples menu: each board lists existing examples, every example is listed somewhere
  const { BOARDS } = require('../js/boards.js');
  const listed = new Set(Object.values(BOARD_EXAMPLES).flat());
  const ids = new Set(EXAMPLES.map(e => e.id));
  check('per-board example lists', Object.keys(BOARD_EXAMPLES).every(b => BOARDS[b]) && [...listed].every(id => ids.has(id)) &&
    EXAMPLES.every(e => listed.has(e.id)) && BOARD_EXAMPLES.labc3.length === 5 && BOARD_EXAMPLES.xiaoc3.length === 8,
    JSON.stringify(BOARD_EXAMPLES));
  // the wiring of each example only uses GPIOs of the boards that list it
  const bad = [];
  for (const [b, list] of Object.entries(BOARD_EXAMPLES)) {
    for (const id of list) {
      for (const c of EXAMPLES.find(e => e.id === id).components) {
        for (const [pin, g] of Object.entries(c.conn)) if (typeof g === 'number' && !BOARDS[b].gpios.includes(g)) bad.push(`${b}/${id}/${c.id}.${pin}=${g}`);
      }
    }
  }
  check('example wiring fits each board', !bad.length, bad.join(', '));
}

{ // IO_MUX: reset values, FUN_IE gating, internal pulls, floating detection
  const run = src => { const m = new ESP32C3(); m.load(RVAsm.assemble(src)); m.run(1000, null, Infinity); return m; };
  const rd = 'li t0, 0x60004000\n lw a0, 0x3C(t0)\n';
  const ioReg = g => 0x60009004 + 4 * g;
  let m = run('li t0, 0x60009028\n lw a0, 0(t0)\n j .');      // IO_MUX_GPIO9_REG
  check('io_mux reset GPIO9 (IE + WPU)', m.core.x[10] === 0xB00, hex(m.core.x[10]));
  m = run('li t0, 0x60009004\n lw a0, 0(t0)\n j .');          // IO_MUX_GPIO0_REG
  check('io_mux reset GPIO0 (input off)', m.core.x[10] === 0x800, hex(m.core.x[10]));
  // GPIO4: IE on, no pull at reset -> floating; forced high it reads 1
  m = new ESP32C3(); m.load(RVAsm.assemble(rd + 'j .')); m.setExternal({ force: 1 << 4, value: 1 << 4 });
  m.run(1000, null, Infinity);
  check('GPIO_IN sees a driven input', ((m.core.x[10] >> 4) & 1) === 1, hex(m.core.x[10]));
  // FUN_IE cleared -> reads 0 even though the pin is high
  m = new ESP32C3();
  m.load(RVAsm.assemble(`li t1, ${ioReg(4)}\n li t2, 0x800\n sw t2, 0(t1)\n` + rd + 'j .'));
  m.setExternal({ force: 1 << 4, value: 1 << 4 });
  m.run(1000, null, Infinity);
  check('FUN_IE = 0 reads 0', ((m.core.x[10] >> 4) & 1) === 0 && ((m.ieOffReads >> 4) & 1) === 1, hex(m.core.x[10]));
  // floating GPIO4 is reported; with FUN_WPU it reads 1 and is not floating
  m = run(rd + 'j .');
  check('floating read reported', ((m.floatReads >> 4) & 1) === 1 && ((m.core.x[10] >> 4) & 1) === 0, hex(m.floatReads));
  m = run(`li t1, ${ioReg(4)}\n li t2, 0xB00\n sw t2, 0(t1)\n` + rd + 'j .');
  check('FUN_WPU pulls up', ((m.core.x[10] >> 4) & 1) === 1 && ((m.floatReads >> 4) & 1) === 0, hex(m.core.x[10]));
  m = run(`li t1, ${ioReg(4)}\n li t2, 0xA80\n sw t2, 0(t1)\n` + rd + 'j .');
  check('FUN_WPD pulls down', ((m.core.x[10] >> 4) & 1) === 0 && ((m.floatReads >> 4) & 1) === 0, hex(m.core.x[10]));
}

{ // IO_MUX MCU_SEL and pin states after reset (datasheet Table 2-3, values measured on a chip)
  const fresh = () => { const m = new ESP32C3(); m.load(RVAsm.assemble('j .')); return m; };
  let m = fresh();
  // values read back on a real ESP32-C3 after a flash boot
  check('io_mux reset GPIO6 (MTCK: IE, no pull)', m.iomux[6] === 0xA00, hex(m.iomux[6]));
  check('io_mux reset GPIO12 (function 1 after DIO flash boot)', m.iomux[12] === 0x1B00 && ((m.gpioFnMask >> 12) & 1) === 1, hex(m.iomux[12]));
  check('io_mux reset GPIO21 (U0TXD: IE + WPU)', m.iomux[21] === 0xB00, hex(m.iomux[21]));
  check('U0TXD idles high', ((m.levels() >> 21) & 1) === 1 && ((m.floatingPins() >> 21) & 1) === 0, hex(m.levels()));
  check('USB D+ pulled up', ((m.levels() >> 19) & 1) === 1 && ((m.floatingPins() >> 19) & 1) === 0, hex(m.levels()));
  // GPIO2 (function 0 = GPIO2) is driven directly; GPIO4 (function 0 = MTMS) needs MCU_SEL = 1
  const out = 'li t0, 0x60004000\n li t1, 0x14\n sw t1, 0x24(t0)\n sw t1, 0x08(t0)\n';
  m = new ESP32C3(); m.load(RVAsm.assemble(out + 'j .')); m.run(1000, null, Infinity);
  check('GPIO out blocked in function 0 (MTMS)', ((m.levels() >> 2) & 1) === 1 && ((m.levels() >> 4) & 1) === 0 && m.noFnWrites === 0x10,
    hex(m.levels()) + ' ' + hex(m.noFnWrites));
  m = new ESP32C3();
  m.load(RVAsm.assemble('li t2, 0x60009014\n li t3, 0x1A00\n sw t3, 0(t2)\n' + out + 'j .'));
  m.run(1000, null, Infinity);
  check('GPIO out with MCU_SEL = 1', ((m.levels() >> 4) & 1) === 1 && m.noFnWrites === 0, hex(m.levels()));
  // GPIO21 in function 1 is a plain GPIO: no longer driven by the UART
  m = new ESP32C3();
  m.load(RVAsm.assemble('li t2, 0x60009058\n li t3, 0x1800\n sw t3, 0(t2)\n j .'));
  m.run(1000, null, Infinity);
  check('GPIO21 as GPIO floats', ((m.floatingPins() >> 21) & 1) === 1, hex(m.floatingPins()));
}

{ // uart echo
  const m = exampleMachine('uart');
  m.run(2e6, null, Infinity);
  const greet = Buffer.from(m.tx).toString();
  m.tx.length = 0;
  m.uartReceive([...Buffer.from('hi')]);
  m.run(4e6, null, Infinity);
  const echo = Buffer.from(m.tx).toString();
  check('uart greeting', greet.startsWith('Hello from ESP32-C3'), JSON.stringify(greet));
  check('uart echo', echo === 'hi', JSON.stringify(echo));
}

{ // SuperMini / XIAO UART example: hello + echo over the USB-Serial-JTAG model
  const m = exampleMachine('uart-usb');
  m.run(2e5, null, Infinity);
  m.uartReceive([...Buffer.from('hi!\n')]);
  m.run(4e5, null, Infinity);
  check('uart-usb over the USB-Serial-JTAG model', Buffer.from(m.tx).toString().endsWith('Type something:\nHI!\n'), JSON.stringify(Buffer.from(m.tx).toString()));
}

{ // Lab board examples: LEDs / 7-seg on GPIO0..7, PB1..PB4 on GPIO9, 10, 20, 21 (pulled up by jumper PB)
  const PB = [9, 10, 20, 21], PULL = PB.reduce((m, g) => m | (1 << g), 0) | (1 << 8);
  const press = (m, i, t) => {
    m.setExternal({ force: 1 << PB[i], value: 0, pullUp: PULL });
    m.run(m.core.cycle + CPU_HZ * 0.05, null, Infinity);
    m.setExternal({ pullUp: PULL });
    m.run(m.core.cycle + CPU_HZ * (t || 0.05), null, Infinity);
  };

  let m = exampleMachine('lab-chaser');
  m.setExternal({ pullUp: PULL });
  m.run(CPU_HZ * 0.02, null, Infinity);
  const first = m.levels() & 0xFF;
  m.run(CPU_HZ * 0.17, null, Infinity);
  const second = m.levels() & 0xFF;
  press(m, 0, 0.01);                                                    // PB1: reverse
  m.run(m.core.cycle + CPU_HZ * 0.3, null, Infinity);
  const back = m.levels() & 0xFF;
  press(m, 3, 0.01);                                                    // PB4 (GPIO21, was U0TXD): pause
  const paused = m.levels() & 0xFF;
  m.run(m.core.cycle + CPU_HZ * 0.5, null, Infinity);
  check('lab-chaser runs, reverses (PB1) and pauses (PB4)',
    first === 0x01 && second === 0x02 && (back === 0x01 || back === 0x80) && paused === (m.levels() & 0xFF) && m.pinFunction(21) === 'GPIO21',
    [first, second, back, paused, m.levels() & 0xFF].map(v => v.toString(16)).join());

  m = exampleMachine('lab-counter');
  m.setExternal({ pullUp: PULL });
  m.run(CPU_HZ * 0.02, null, Infinity);
  const zero = m.levels() & 0xFF;
  press(m, 0); press(m, 0); press(m, 0);                                // PB1 x3: 3
  const three = m.levels() & 0xFF;
  press(m, 1); press(m, 1); press(m, 1); press(m, 1);                   // PB2 x4: F
  press(m, 3);                                                          // PB4: decimal point
  const fdp = m.levels() & 0xFF;
  press(m, 2);                                                          // PB3 (GPIO20): reset
  const out = Buffer.from(m.tx).toString();
  check('lab-counter counts with PB1..PB3 and toggles the dot with PB4',
    zero === 0x3F && three === 0x4F && fdp === 0xF1 && (m.levels() & 0xFF) === 0xBF &&
    out === 'value = 1\nvalue = 2\nvalue = 3\nvalue = 2\nvalue = 1\nvalue = 0\nvalue = 15\nvalue = 15\nvalue = 0\n',
    [zero, three, fdp, m.levels() & 0xFF].map(v => v.toString(16)).join() + ' ' + JSON.stringify(out));

  m = exampleMachine('lab-led');
  m.run(CPU_HZ * 0.25, null, Infinity);
  const odd = m.levels() & 0xFF;
  m.run(CPU_HZ * 0.75, null, Infinity);
  check('lab-led blinks the odd and the even LEDs in turn', odd === 0x55 && (m.levels() & 0xFF) === 0xAA, [odd, m.levels() & 0xFF].map(v => v.toString(16)).join());

  m = exampleMachine('lab-button');
  m.setExternal({ pullUp: PULL });
  m.run(CPU_HZ * 0.03, null, Infinity);
  const idle = m.levels() & 0xFF;
  m.setExternal({ force: 1 << PB[2], value: 0, pullUp: PULL });          // hold PB3 (GPIO20)
  m.run(m.core.cycle + CPU_HZ * 0.05, null, Infinity);
  const held = m.levels() & 0xFF;
  m.setExternal({ pullUp: PULL });
  m.run(m.core.cycle + CPU_HZ * 0.05, null, Infinity);
  const after = m.levels() & 0xFF;
  press(m, 2);                                                          // PB3 again: LED7 off
  check('lab-button: PB3 lights LED3 while held and toggles LED7', idle === 0 && held === 0x44 && after === 0x40 && (m.levels() & 0xFF) === 0,
    [idle, held, after, m.levels() & 0xFF].map(v => v.toString(16)).join());

  m = exampleMachine('lab-7seg');
  m.run(CPU_HZ * 0.5, null, Infinity);
  const s0 = m.levels() & 0xFF;
  m.run(CPU_HZ * 1.5, null, Infinity);
  check('lab-7seg counts 0, 1, ...', s0 === 0x3F && (m.levels() & 0xFF) === 0x06, [s0, m.levels() & 0xFF].map(v => v.toString(16)).join());
}

// ---- MAX7219: serial protocol, registers, daisy chain, and the matrix example end to end
{
  const { MAX7219Chain } = require('../js/max7219.js');
  const send = (chain, words) => {       // words[0] goes out first (ends up in the farthest chip)
    chain.input(0, 1, 0);
    chain.input(0, 0, 0);
    for (const w of words) for (let b = 15; b >= 0; b--) { const d = (w >> b) & 1; chain.input(d, 0, 0); chain.input(d, 0, 1); }
    chain.input(0, 0, 0);
    chain.input(0, 1, 0);
  };
  const one = new MAX7219Chain(1);
  send(one, [0x0181]);
  check('MAX7219 starts in shutdown (blank)', one.chips[0].rows().every(r => r === 0) && one.chips[0].digits[0] === 0x81);
  send(one, [0x0C01]); send(one, [0x0B07]); send(one, [0x0A0F]);
  check('MAX7219 shows digit registers after leaving shutdown', one.chips[0].rows()[0] === 0x81 && one.chips[0].brightness() === 31 / 32);
  send(one, [0x0B00]);
  send(one, [0x0242]);
  check('MAX7219 scan limit hides digits 1..7', one.chips[0].rows()[1] === 0 && one.chips[0].digits[1] === 0x42);
  send(one, [0x0B07]); send(one, [0x0901]); send(one, [0x0185]);
  check('MAX7219 code B decode on digit 0', one.chips[0].rows()[0] === (0x80 | 0x5B) && one.chips[0].rows()[1] === 0x42);
  send(one, [0x0C00]); send(one, [0x0F01]);
  check('MAX7219 display test lights everything, even in shutdown', one.chips[0].rows().every(r => r === 0xFF));

  const four = new MAX7219Chain(4);
  send(four, [0x0104, 0x0103, 0x0102, 0x0101]);
  check('MAX7219 daisy chain: the first word reaches the last chip', four.chips.map(c => c.digits[0]).join() === '1,2,3,4', four.chips.map(c => c.digits[0]).join());
  send(four, [0x0000, 0x0000, 0x0000, 0x01AA]);
  check('MAX7219 no-op words leave the other chips alone', four.chips.map(c => c.digits[0]).join() === '170,2,3,4', four.chips.map(c => c.digits[0]).join());

  const m = exampleMachine('matrix');
  const mx = new MAX7219Chain(1);
  m.onPinsChanged = l => mx.input((l >>> 2) & 1, (l >>> 3) & 1, (l >>> 10) & 1);
  m.run(CPU_HZ * 0.1, null, Infinity);
  const heart = [...mx.chips[0].rows()].join();
  m.run(CPU_HZ * 0.8, null, Infinity);
  const smiley = [...mx.chips[0].rows()].join();
  check('matrix example draws a heart, then a smiley',
    heart === '0,102,255,255,255,126,60,24' && smiley === '60,66,165,129,165,153,66,60' && Buffer.from(m.tx).toString() === 'heart\nsmiley\n',
    heart + ' | ' + smiley);
}

// ---- TM1637: two-wire protocol with ACK, commands, and the clock example end to end
{
  const { TM1637 } = require('../js/tm1637.js');
  const tm = new TM1637();
  let acks = '';
  const xfer = bytes => {               // start, bytes LSB first with an ACK clock each, stop
    tm.input(1, 1); tm.input(1, 0); tm.input(0, 0);
    for (const b of bytes) {
      for (let i = 0; i < 8; i++) { const d = (b >> i) & 1; tm.input(0, d); tm.input(1, d); tm.input(0, d); }
      acks += tm.ack ? 'A' : '-';
      tm.input(1, 0); tm.input(0, 0);
      acks += tm.ack ? 'A' : '-';
    }
    tm.input(0, 0); tm.input(1, 0); tm.input(1, 1);
  };
  xfer([0x40]); xfer([0xC0, 0x3F, 0x86, 0x5B, 0x4F]);
  check('TM1637 acknowledges each byte for one clock', acks === 'A-'.repeat(6), acks);
  check('TM1637 display stays off until the display control command', [...tm.segments()].every(v => v === 0) && tm.regs[1] === 0x86);
  xfer([0x8B]);
  check('TM1637 display on, brightness 3 = 10/16', tm.segments().slice(0, 4).join() === '63,134,91,79' && tm.brightness() === 10 / 16);
  xfer([0x44]); xfer([0xC2, 0x06, 0x07]);
  check('TM1637 fixed address mode', tm.regs[2] === 0x07 && tm.regs[3] === 0x4F, [...tm.regs].join());
  xfer([0x80]);
  check('TM1637 display off blanks the digits', tm.brightness() === 0 && [...tm.segments()].every(v => v === 0));

  // Clock example, with the module's pull-ups and the chip's ACK on DIO (GPIO3) as in app.js.
  const run = attach => {
    const m = exampleMachine('tm1637');
    m.setExternal({ pullUp: (1 << 2) | (1 << 3) });
    const chip = new TM1637();
    chip.clk = 1; chip.dio = 1;           // both lines idle HIGH (pulled up)
    if (attach) m.onPinsChanged = l => { chip.input((l >>> 2) & 1, (l >>> 3) & 1); m.setDeviceDrive(chip.ack ? 1 << 3 : 0); };
    return { m, chip };
  };
  const { m, chip } = run(true);
  m.run(CPU_HZ * 2.2, null, Infinity);
  const t1 = chip.segments().slice(0, 4).join();
  m.run(CPU_HZ * 2.6, null, Infinity);
  const t2 = chip.segments().slice(0, 4).join();
  check('tm1637 example shows 00:02 with a blinking colon', t1 === '63,191,63,91' && t2 === '63,63,63,91' && chip.brightness() === 11 / 16 && m.tx.length === 0,
    t1 + ' | ' + t2 + ' | ' + Buffer.from(m.tx).toString());
  const alone = run(false).m;
  alone.run(CPU_HZ * 0.01, null, Infinity);
  check('tm1637 example reports a missing ACK', Buffer.from(alone.tx).toString().startsWith('No ACK'), Buffer.from(alone.tx).toString());
}

{ // sampleDuty: software PWM on GPIO2 at 25 % duty
  const m = new ESP32C3();
  m.load(RVAsm.assemble(`
main:   li   s0, 0x60004000
        li   s1, 1 << 2
        sw   s1, 0x24(s0)
loop:   sw   s1, 0x08(s0)       # HIGH for 100 iterations
        li   t0, 100
1:      addi t0, t0, -1
        bnez t0, 1b
        sw   s1, 0x0C(s0)       # LOW for 300
        li   t0, 300
2:      addi t0, t0, -1
        bnez t0, 2b
        j    loop
`));
  m.run(100000, null, Infinity);
  m.sampleDuty();
  m.run(1100000, null, Infinity);
  const d = m.sampleDuty()[2];
  check('sampleDuty measures PWM duty', Math.abs(d - 0.25) < 0.02, d.toFixed(3));
}

// ---- LCD1602: HD44780 in 4-bit mode, the PCF8574 I2C backpack, and both examples end to end
{
  const { HD44780, LCDI2C } = require('../js/lcd1602.js');
  const US = 160;                        // CPU cycles per microsecond
  const text = (lcd, r) => String.fromCharCode(...lcd.screen().rows[r]);
  let t = 20000 * US;                    // after the 15 ms power-up busy time
  const lcd = new HD44780(US);
  const pulse = (rs, d, us = 2000) => { lcd.input(rs, 0, 0, d, t); lcd.input(rs, 0, 1, d, t); lcd.input(rs, 0, 0, d, t); t += us * US; };
  const byte = (rs, b, us) => { pulse(rs, b >> 4, us); pulse(rs, b & 15, us); };
  lcd.input(0, 0, 0, 0, t);
  pulse(0, 3); pulse(0, 3); pulse(0, 3); pulse(0, 2);
  [0x28, 0x0C, 0x06, 0x01].forEach(b => byte(0, b));
  for (const ch of 'Hi') byte(1, ch.charCodeAt(0));
  byte(0, 0xC0); byte(1, 0x41);
  check('HD44780 4-bit set-up and text on both lines', text(lcd, 0).startsWith('Hi  ') && text(lcd, 1).startsWith('A ') && lcd.lost === 0 && lcd.on && lcd.lines2,
    JSON.stringify([text(lcd, 0), text(lcd, 1), lcd.lost]));
  // Busy flag: right after a clear the controller is busy for 1.52 ms and ignores bytes.
  const read = rs => { let v = 0; for (const sh of [4, 0]) { lcd.input(rs, 1, 1, 0, t); v |= lcd.output() << sh; lcd.input(rs, 1, 0, 0, t); } return v; };
  byte(0, 0x01, 0);
  const bf = read(0);
  byte(1, 0x42, 0);
  t += 2000 * US;
  check('HD44780 busy flag after clear, byte lost while busy', (bf & 0x80) && (read(0) & 0x80) === 0 && lcd.lost === 1 && text(lcd, 0).trim() === '', [bf, lcd.lost]);
  byte(0, 0x40); [0x0A, 0x1F].forEach(b => byte(1, b)); byte(0, 0x80); byte(1, 0);
  check('HD44780 CGRAM custom character', lcd.glyph(lcd.screen().rows[0][0]).slice(0, 2).join() === '10,31');
  byte(0, 0x80); const r = read(1);
  t += 100 * US;
  check('HD44780 data read returns DDRAM and advances', r === 0 && read(0) === 0x01, [r]);

  // PCF8574 backpack: address match / NACK, port writes, port read with ACK on SDA
  const bp = new LCDI2C(0x27, US);
  let acks = '';
  const level = (scl, sda) => bp.input(scl, bp.sink ? 0 : sda, t);
  const i2c = (bytes, readN = 0) => {
    level(1, 1); level(1, 0); level(0, 0);
    for (const b of bytes) {
      for (let i = 7; i >= 0; i--) { const d = (b >> i) & 1; level(0, d); level(1, d); level(0, d); }
      level(0, 1); level(1, 1); acks += bp.sink ? 'A' : 'N'; level(0, 1);
    }
    const got = [];
    for (let k = 0; k < readN; k++) {
      let v = 0;
      for (let i = 7; i >= 0; i--) { level(1, 1); v |= (bp.sink ? 0 : 1) << i; level(0, 1); }
      const last = k === readN - 1;
      level(0, last ? 1 : 0); level(1, last ? 1 : 0); level(0, last ? 1 : 0);
      got.push(v);
    }
    level(0, 0); level(1, 0); level(1, 1);
    return got;
  };
  i2c([0x3F << 1]);
  i2c([0x27 << 1, 0x08, 0x52]);
  const got = i2c([0x27 << 1 | 1], 2);
  check('PCF8574: wrong address NACKed, writes ACKed and set the port', acks === 'NAAAA' && bp.port === 0x52 && !bp.backlight, acks);
  check('PCF8574: read returns the port', got.join() === '82,82', got.join());
  t += 100 * US;
  i2c([0x27 << 1, 0xF2, 0xF6]);           // RW = 1, then E = 1: the LCD drives D7..D4 (busy flag 0, address 0)
  const bfRead = i2c([0x27 << 1 | 1], 1);
  check('PCF8574: read sees the LCD pulling D4..D7 low', bfRead.join() === '6', bfRead.join());

  const lcdMachine = (id, attach) => {
    const m = exampleMachine(id);
    const ex = EXAMPLES.find(e => e.id === id), conn = ex.components[0].conn;
    const bit = (l, g) => g === undefined ? 0 : (l >>> g) & 1;
    if (ex.components[0].type === 'lcd1602') {
      const dev = new HD44780(US), D = [conn.D4, conn.D5, conn.D6, conn.D7];
      dev.e = 0;
      m.onPinsChanged = l => {
        dev.input(bit(l, conn.RS), bit(l, conn.RW), bit(l, conn.E), D.reduce((n, g, i) => n | bit(l, g) << i, 0), m.core.cycle);
        const n = dev.output();
        let mask = 0, v = 0;
        if (n !== null) D.forEach((g, i) => { mask |= 1 << g; if ((n >> i) & 1) v |= 1 << g; });
        m.setDeviceDrive(mask, v);
      };
      return { m, lcd: dev };
    }
    const dev = new LCDI2C(0x27, US);
    m.setExternal({ pullUp: (1 << conn.SDA) | (1 << conn.SCL) });
    dev.scl = 1; dev.sda = 1;
    if (attach) m.onPinsChanged = l => { dev.input(bit(l, conn.SCL), bit(l, conn.SDA), m.core.cycle); m.setDeviceDrive(dev.sink ? 1 << conn.SDA : 0); };
    return { m, lcd: dev.lcd, dev };
  };
  {
    const { m, lcd: l } = lcdMachine('lcd', true);
    m.run(CPU_HZ * 0.35, null, Infinity);
    check('lcd example: text, custom heart and counter, nothing lost',
      text(l, 0) === 'Hello, ESP32-C3!' && text(l, 1).startsWith('Count: 0000') && l.screen().rows[1][15] === 0 && l.lost === 0,
      JSON.stringify([text(l, 0), text(l, 1), l.lost]));
  }
  {
    const { m, lcd: l, dev } = lcdMachine('lcd-i2c', true);
    m.run(CPU_HZ * 1.2, null, Infinity);
    check('lcd-i2c example: text and seconds, backlight on, nothing lost',
      text(l, 0) === 'LCD1602 over I2C' && text(l, 1) === 'Seconds: 00001  ' && dev.backlight && l.lost === 0 && m.tx.length === 0,
      JSON.stringify([text(l, 0), text(l, 1), l.lost, Buffer.from(m.tx).toString()]));
    const alone = lcdMachine('lcd-i2c', false).m;
    alone.run(CPU_HZ * 0.06, null, Infinity);
    check('lcd-i2c example reports a missing ACK', Buffer.from(alone.tx).toString().startsWith('No ACK'), Buffer.from(alone.tx).toString());
  }
}

// ---- boards: every header GPIO is listed once, and the wireable GPIOs are exactly those
{
  const { BOARDS } = require('../js/boards.js');
  for (const [id, b] of Object.entries(BOARDS)) {
    const header = b.left.concat(b.right).filter(l => /^\d+$/.test(l)).map(Number);
    const ok = header.length === new Set(header).size && JSON.stringify([...header].sort((x, y) => x - y)) === JSON.stringify([...b.gpios].sort((x, y) => x - y));
    check(`board ${id} pin list`, ok, JSON.stringify(header));
  }
  const mini = BOARDS.supermini;
  check('SuperMini pinout (USB-C up)', mini.left.join() === '5,6,7,8,9,10,20,21' && mini.right.join() === '5V,GND,3V3,4,3,2,1,0', mini.left.join() + ' | ' + mini.right.join());
  const xiao = BOARDS.xiaoc3;
  const lab = BOARDS.labc3;
  check('Lab board: SuperMini headers, LEDs / 7-seg on GPIO0..7, buttons on GPIO9, 10, 20, 21',
    lab.left.join() === mini.left.join() && lab.right.join() === mini.right.join() &&
    lab.lab.leds.map(l => l.gpio).join() === '0,1,2,3,4,5,6,7' && Object.values(lab.lab.seg.pins).join() === '0,1,2,3,4,5,6,7' &&
    lab.lab.buttons.map(b => b.gpio).join() === '9,10,20,21');
  check('XIAO ESP32C3 pinout (USB-C up, D0-D6 left, D10-D7 right)', xiao.left.join() === '2,3,4,5,6,7,21' && xiao.right.join() === '5V,GND,3V3,10,9,8,20', xiao.left.join() + ' | ' + xiao.right.join());
}

// ---- hardware build: Espressif image layout, checksum and SHA-256
{
  const Firmware = require('../js/firmware.js');
  const crypto = require('crypto');
  for (const ex of EXAMPLES) {
    const fw = Firmware.buildFirmware(RVAsm.assemble(ex.code));
    const img = Buffer.from(fw.image), body = img.subarray(0, img.length - 32);
    let chk = 0xEF, off = 24;
    for (let i = 0; i < img[1]; i++) {
      const len = img.readUInt32LE(off + 4);
      for (const b of img.subarray(off + 8, off + 8 + len)) chk ^= b;
      off += 8 + len;
    }
    const ok = img[0] === 0xE9 && img[1] === fw.segments.length && img.readUInt16LE(12) === 5 && img[23] === 1 &&
      body.length % 16 === 0 && body[body.length - 1] === chk &&
      crypto.createHash('sha256').update(body).digest().equals(img.subarray(img.length - 32)) &&
      img.readUInt32LE(4) === fw.entry && fw.entry >= fw.runtime.base && fw.entry < fw.runtime.base + fw.runtime.size &&
      fw.runtime.base % 256 === 0;
    check(`firmware image ${ex.id}`, ok, `${img.length} bytes, entry ${hex(fw.entry)}`);
  }
  let err = '';
  try { Firmware.buildFirmware(RVAsm.assemble('main: j main\n.data\n.space 0x3A000\n')); } catch (e) { err = e.message; }
  check('firmware rejects .data that reaches the stack', /stack/.test(err), err);
}

// ---- breakpoints
{
  const r = RVAsm.assemble('main: li a0, 1\n li a0, 2\n li a0, 3\nhere: j here\n');
  const m = new ESP32C3();
  m.load(r);
  const bp = new Set([r.lineToAddr.get(3)]);
  const res = m.run(1000, bp, Infinity);
  check('breakpoint stops', res === 'breakpoint' && m.core.x[10] === 2, res);
  const res2 = m.run(1000, bp, Infinity, true);
  check('resume after breakpoint', res2 === 'budget' && m.core.x[10] === 3, res2);
}

// ---- speed benchmark
{
  const m = exampleMachine('blink');
  const t0 = Date.now();
  m.run(50e6, null, Infinity);
  const dt = (Date.now() - t0) / 1000;
  console.log(`benchmark: ${(50 / dt).toFixed(1)} M instructions/s (${(50e6 / dt / CPU_HZ * 100).toFixed(0)}% of real time)`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
