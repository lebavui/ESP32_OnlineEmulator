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
  m.setExternal(1 << 4);           // released (pulled up)
  m.run(100000, null, Infinity);
  const off = (m.levels() >> 2) & 1;
  m.setExternal(0);                // pressed
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
  m.setExternal(1 << 10); adv(10);
  for (let i = 0; i < 3; i++) { m.setExternal(0); adv(60); m.setExternal(1 << 10); adv(60); }
  check('counter example', (m.levels() & 0xff) === 0x4f, hex(m.levels() & 0xff));
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
