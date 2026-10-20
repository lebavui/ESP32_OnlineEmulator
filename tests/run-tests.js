/* Run with: node tests/run-tests.js */
'use strict';
const RVAsm = require('../js/assembler.js');
const { ESP32C3 } = require('../js/esp32c3.js');
const { EXAMPLES } = require('../js/examples.js');

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
}

{ // counter: press 3 times
  const m = exampleMachine('counter');
  let t = 0;
  const adv = ms => { t += ms / 1000 * CPU_HZ; m.run(t, null, Infinity); };
  const pressed = { force: 1 << 10, value: 0 }, released = {};
  m.setExternal(released); adv(10);
  for (let i = 0; i < 3; i++) { m.setExternal(pressed); adv(60); m.setExternal(released); adv(60); }
  check('counter example', (m.levels() & 0xff) === 0x4f, hex(m.levels() & 0xff));
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

{ // traffic light: green first, then yellow (GPIO4, 5 need MCU_SEL = 1)
  const m = exampleMachine('traffic');
  m.run(CPU_HZ * 1, null, Infinity);
  const a = (m.levels() >> 3) & 7;
  m.run(CPU_HZ * 3.5, null, Infinity);
  const b = (m.levels() >> 3) & 7;
  check('traffic example', a === 4 && b === 2 && m.noFnWrites === 0, [a, b]);
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

{ // syscalls
  const m = exampleMachine('syscalls');
  const res = m.run(CPU_HZ * 10, null, Infinity);
  const out = Buffer.from(m.tx).toString();
  check('fibonacci', res === 'halt' && out.includes('46368\n'), res + ' ' + JSON.stringify(out.slice(-40)));
}

{ // SuperMini examples: on-board LED on GPIO8 (active low), BOOT button, USB-Serial-JTAG echo
  let m = exampleMachine('mini-blink');
  m.run(CPU_HZ * 0.25, null, Infinity);
  const on = (m.levels() >> 8) & 1;
  m.run(CPU_HZ * 0.75, null, Infinity);
  const off = (m.levels() >> 8) & 1;
  check('mini-blink drives GPIO8 low then high', on === 0 && off === 1 && Buffer.from(m.tx).toString().startsWith('LED on\nLED off\n'), [on, off]);

  m = exampleMachine('mini-boot');
  m.setExternal({ pullUp: 1 << 9 });
  m.run(CPU_HZ * 0.05, null, Infinity);
  m.setExternal({ force: 1 << 9, value: 0, pullUp: 1 << 9 });          // press BOOT
  m.run(CPU_HZ * 0.15, null, Infinity);
  m.setExternal({ pullUp: 1 << 9 });                                   // release
  m.run(CPU_HZ * 0.3, null, Infinity);
  check('mini-boot counts a press and toggles the LED', Buffer.from(m.tx).toString() === 'BOOT pressed: 1\n' && ((m.levels() >> 8) & 1) === 0,
    JSON.stringify(Buffer.from(m.tx).toString()));

  m = exampleMachine('usb-echo');
  m.run(2e5, null, Infinity);
  m.uartReceive([...Buffer.from('hi!\n')]);
  m.run(4e5, null, Infinity);
  check('usb-echo over the USB-Serial-JTAG model', Buffer.from(m.tx).toString().endsWith('Type something:\nHI!\n'), JSON.stringify(Buffer.from(m.tx).toString()));
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
