/*
 * "Build for hardware": turn an assembled program into an ESP32-C3 firmware image.
 *
 * The image is in Espressif's app-image format (the one the ROM bootloader loads from flash
 * offset 0x0): every section becomes a RAM segment, so the program runs straight from SRAM
 * with the same addresses as in the simulator. A small runtime is added in front of the
 * program; it does what the simulator does implicitly:
 *   - turns off the watchdogs the ROM leaves running (RTC WDT, super WDT, TIMG0/1 WDT),
 *   - sets sp / gp and clears the other registers,
 *   - installs a trap handler that implements the simulator's ecall services (print, time,
 *     sleep, read_char, exit) over USB-Serial-JTAG and UART0, emulates the standard counter
 *     CSRs (cycle, time, instret and their m-/h- forms), which the ESP32-C3 doesn't have, with
 *     its own cycle counter (CSR 0x7E2), and reports any other exception (mcause, mepc,
 *     mtval) instead of silently resetting.
 * The CPU runs at 20 MHz (XTAL / 2, as the ROM leaves it), not the simulator's 160 MHz.
 */
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const RVAsm = isNode ? require('./assembler.js') : root.RVAsm;

  const IRAM_BASE = 0x40380000, DRAM_BASE = 0x3FC80000, IRAM_DRAM_OFFSET = IRAM_BASE - DRAM_BASE;
  const CHIP_ID_ESP32C3 = 5;
  // RAM the runtime keeps for itself, below the ROM's own data at the top of SRAM:
  // the program's stack grows down from HW_STACK_TOP; registers saved on a trap and the
  // trap handler's stack sit above it.
  const HW_STACK_TOP = 0x3FCDA000;
  const HW_SAVE = HW_STACK_TOP;               // 32 words
  const HW_TRAP_STACK = HW_STACK_TOP + 0x600;
  const RUNTIME_ALIGN = 256;                  // mtvec base alignment (vectored mode)

  const RUNTIME_SRC = `
# ---------------------------------------------------------------- RVSim C3 hardware runtime
        .equ RTC_CNTL,          0x60008000
        .equ RTC_WDTCONFIG0,    0x90
        .equ RTC_WDTWPROTECT,   0xA8
        .equ RTC_SWD_CONF,      0xAC
        .equ RTC_SWD_WPROTECT,  0xB0
        .equ WDT_WKEY,          0x50D83AA1
        .equ SWD_WKEY,          0x8F1D312A
        .equ SWD_AUTO_FEED_EN,  1 << 31
        .equ TIMG0,             0x6001F000
        .equ TIMG1,             0x60020000
        .equ TIMG_WDTCONFIG0,   0x48
        .equ TIMG_WDTWPROTECT,  0x64
        .equ UART0,             0x60000000
        .equ USB_SERIAL,        0x60043000     # EP1 FIFO at +0, EP1_CONF at +4
        .equ SYSTIMER,          0x60023000
        .equ IRAM_DRAM_OFFSET,  ${IRAM_DRAM_OFFSET}

        .text
# Trap vector table (mtvec in vectored mode): exceptions enter at offset 0.
vectors:
${'        j       trap\n'.repeat(32)}
_hw_start:
        li      t0, RTC_CNTL                    # RTC watchdog off
        li      t1, WDT_WKEY
        sw      t1, RTC_WDTWPROTECT(t0)
        sw      zero, RTC_WDTCONFIG0(t0)
        sw      zero, RTC_WDTWPROTECT(t0)
        li      t1, SWD_WKEY                    # super watchdog: feed itself
        sw      t1, RTC_SWD_WPROTECT(t0)
        lw      t2, RTC_SWD_CONF(t0)
        li      t3, SWD_AUTO_FEED_EN
        or      t2, t2, t3
        sw      t2, RTC_SWD_CONF(t0)
        sw      zero, RTC_SWD_WPROTECT(t0)
        li      t1, WDT_WKEY
        li      t0, TIMG0                       # timer group watchdogs off
        sw      t1, TIMG_WDTWPROTECT(t0)
        sw      zero, TIMG_WDTCONFIG0(t0)
        sw      zero, TIMG_WDTWPROTECT(t0)
        li      t0, TIMG1
        sw      t1, TIMG_WDTWPROTECT(t0)
        sw      zero, TIMG_WDTCONFIG0(t0)
        sw      zero, TIMG_WDTWPROTECT(t0)

        li      t0, 1                           # Espressif performance counter: count cycles
        csrw    0x7E0, t0                       # mpcer
        csrw    0x7E1, t0                       # mpcmr: on
        csrw    0x7E2, zero                     # mpccr = 0

        la      t0, vectors
        ori     t0, t0, 1
        csrw    mtvec, t0
        li      t0, HW_SAVE
        sw      zero, 128(t0)                   # USB "host not reading" flag

        li      sp, HW_STACK_TOP
        li      gp, USER_GP
        li      ra, 0
        li      tp, 0
        li      t1, 0
        li      t2, 0
        li      s0, 0
        li      s1, 0
        li      a0, 0
        li      a1, 0
        li      a2, 0
        li      a3, 0
        li      a4, 0
        li      a5, 0
        li      a6, 0
        li      a7, 0
        li      s2, 0
        li      s3, 0
        li      s4, 0
        li      s5, 0
        li      s6, 0
        li      s7, 0
        li      s8, 0
        li      s9, 0
        li      s10, 0
        li      s11, 0
        li      t3, 0
        li      t4, 0
        li      t5, 0
        li      t6, 0
        li      t0, USER_ENTRY
        jr      t0

# ---------------------------------------------------------------- trap handler
trap:
        csrw    mscratch, t0
        li      t0, HW_SAVE
        sw      x1, 4(t0)
        sw      x2, 8(t0)
        sw      x3, 12(t0)
        sw      x4, 16(t0)
        sw      x6, 24(t0)
        sw      x7, 28(t0)
        sw      x8, 32(t0)
        sw      x9, 36(t0)
        sw      x10, 40(t0)
        sw      x11, 44(t0)
        sw      x12, 48(t0)
        sw      x13, 52(t0)
        sw      x14, 56(t0)
        sw      x15, 60(t0)
        sw      x16, 64(t0)
        sw      x17, 68(t0)
        sw      x18, 72(t0)
        sw      x19, 76(t0)
        sw      x20, 80(t0)
        sw      x21, 84(t0)
        sw      x22, 88(t0)
        sw      x23, 92(t0)
        sw      x24, 96(t0)
        sw      x25, 100(t0)
        sw      x26, 104(t0)
        sw      x27, 108(t0)
        sw      x28, 112(t0)
        sw      x29, 116(t0)
        sw      x30, 120(t0)
        sw      x31, 124(t0)
        csrr    t1, mscratch
        sw      t1, 20(t0)
        li      sp, HW_TRAP_STACK

        csrr    t1, mcause
        li      t2, 11                          # environment call from M-mode
        beq     t1, t2, do_ecall
        li      t2, 3                           # breakpoint
        beq     t1, t2, do_ebreak
        li      t2, 2                           # illegal instruction: maybe a counter CSR
        beq     t1, t2, do_illegal
        j       fatal

# cycle / time / instret (0xC00-0xC02, 0xB00, 0xB02) read mpccr; their high halves read 0.
do_illegal:
        csrr    t1, mtval                       # the faulting instruction
        andi    t2, t1, 0x7F
        li      t3, 0x73                        # SYSTEM opcode
        bne     t2, t3, fatal
        srli    t2, t1, 12
        andi    t2, t2, 3                       # csrrw / csrrs / csrrc (or their i forms)
        beqz    t2, fatal
        srli    t3, t1, 20                      # CSR number
        csrr    t4, 0x7E2
        li      t5, 0xC00
        beq     t3, t5, 1f
        li      t5, 0xC01
        beq     t3, t5, 1f
        li      t5, 0xC02
        beq     t3, t5, 1f
        li      t5, 0xB00
        beq     t3, t5, 1f
        li      t5, 0xB02
        beq     t3, t5, 1f
        li      t4, 0
        li      t5, 0xC80
        beq     t3, t5, 1f
        li      t5, 0xC81
        beq     t3, t5, 1f
        li      t5, 0xC82
        beq     t3, t5, 1f
        li      t5, 0xB80
        beq     t3, t5, 1f
        li      t5, 0xB82
        beq     t3, t5, 1f
        j       fatal
1:      srli    t5, t1, 7
        andi    t5, t5, 31                      # rd
        beqz    t5, 2f
        slli    t5, t5, 2
        add     t5, t5, t0                      # its slot in HW_SAVE
        sw      t4, 0(t5)
2:      csrr    t1, mepc
        addi    t1, t1, 4
        csrw    mepc, t1
        j       trap_return

do_ecall:
        csrr    t1, mepc
        addi    t1, t1, 4
        csrw    mepc, t1
        lw      a0, 40(t0)
        lw      a7, 68(t0)
        call    service
        call    usb_flush
        j       trap_return

do_ebreak:
        la      a0, s_ebreak
        call    puts
        csrr    a0, mepc
        call    put_hex
        la      a0, s_end
        call    puts
        call    usb_flush
        csrr    t1, mepc
        addi    t1, t1, 4
        csrw    mepc, t1
        j       trap_return

fatal:
        la      a0, s_exc
        call    puts
        csrr    a0, mcause
        call    put_hex
        la      a0, s_mepc
        call    puts
        csrr    a0, mepc
        call    put_hex
        la      a0, s_mtval
        call    puts
        csrr    a0, mtval
        call    put_hex
        la      a0, s_end
        call    puts
        j       halt

trap_return:
        li      t0, HW_SAVE
        lw      x1, 4(t0)
        lw      x2, 8(t0)
        lw      x3, 12(t0)
        lw      x4, 16(t0)
        lw      x6, 24(t0)
        lw      x7, 28(t0)
        lw      x8, 32(t0)
        lw      x9, 36(t0)
        lw      x10, 40(t0)
        lw      x11, 44(t0)
        lw      x12, 48(t0)
        lw      x13, 52(t0)
        lw      x14, 56(t0)
        lw      x15, 60(t0)
        lw      x16, 64(t0)
        lw      x17, 68(t0)
        lw      x18, 72(t0)
        lw      x19, 76(t0)
        lw      x20, 80(t0)
        lw      x21, 84(t0)
        lw      x22, 88(t0)
        lw      x23, 92(t0)
        lw      x24, 96(t0)
        lw      x25, 100(t0)
        lw      x26, 104(t0)
        lw      x27, 108(t0)
        lw      x28, 112(t0)
        lw      x29, 116(t0)
        lw      x30, 120(t0)
        lw      x31, 124(t0)
        lw      x5, 20(t0)
        mret

# ---------------------------------------------------------------- ecall services (a7 = number, a0 = argument)
service:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        li      t1, 1
        beq     a7, t1, sv_int
        li      t1, 4
        beq     a7, t1, sv_str
        li      t1, 11
        beq     a7, t1, sv_char
        li      t1, 34
        beq     a7, t1, sv_hex
        li      t1, 35
        beq     a7, t1, sv_bin
        li      t1, 36
        beq     a7, t1, sv_uint
        li      t1, 30
        beq     a7, t1, sv_time
        li      t1, 32
        beq     a7, t1, sv_sleep
        li      t1, 12
        beq     a7, t1, sv_read
        li      t1, 10
        beq     a7, t1, sv_exit
        li      t1, 93
        beq     a7, t1, sv_exit_code
        mv      s0, a7                          # unsupported service
        la      a0, s_unsup
        call    puts
        mv      a0, s0
        call    put_dec
        la      a0, s_end
        call    puts
        j       halt
sv_int:
        bgez    a0, sv_uint
        neg     s0, a0
        li      a0, 45                          # '-'
        call    putc
        mv      a0, s0
sv_uint:
        call    put_dec
        j       sv_done
sv_str:
        call    puts
        j       sv_done
sv_char:
        call    putc
        j       sv_done
sv_hex:
        call    put_hex
        j       sv_done
sv_bin:
        mv      s0, a0
        li      s1, 32
1:      srli    a0, s0, 31
        addi    a0, a0, 48
        call    putc
        slli    s0, s0, 1
        addi    s1, s1, -1
        bnez    s1, 1b
        j       sv_done
sv_time:                                        # a1:a0 = milliseconds since boot
        call    systimer_read                   # a1:a0 = ticks (16 MHz)
        li      t3, 16000
        divu    t4, a1, t3                      # high word of the quotient
        remu    t5, a1, t3                      # running remainder
        li      t6, 0                           # low word of the quotient
        li      t1, 32
2:      slli    t5, t5, 1
        srli    t2, a0, 31
        or      t5, t5, t2
        slli    a0, a0, 1
        slli    t6, t6, 1
        bltu    t5, t3, 3f
        sub     t5, t5, t3
        ori     t6, t6, 1
3:      addi    t1, t1, -1
        bnez    t1, 2b
        li      t0, HW_SAVE
        sw      t6, 40(t0)
        sw      t4, 44(t0)
        j       sv_done
sv_sleep:                                       # a0 = milliseconds
        mv      s0, a0
4:      blez    s0, sv_done
        li      s1, 1000
        bltu    s0, s1, 5f
        mv      a0, s1
        j       6f
5:      mv      a0, s0
6:      sub     s0, s0, a0
        li      t1, 16000
        mul     s1, a0, t1                      # ticks to wait
        call    systimer_read
        add     s1, s1, a0                      # deadline
7:      call    systimer_read
        sub     t1, a0, s1
        bltz    t1, 7b
        j       4b
sv_read:                                        # a0 = next received byte, or -1
        li      t0, USB_SERIAL
        lw      t1, 4(t0)
        andi    t1, t1, 4                       # SERIAL_OUT_EP_DATA_AVAIL
        beqz    t1, 8f
        lw      a0, 0(t0)
        andi    a0, a0, 0xFF
        j       9f
8:      li      t0, UART0
        lw      t1, 0x1C(t0)
        andi    t1, t1, 0x3FF                   # RXFIFO_CNT
        li      a0, -1
        beqz    t1, 9f
        lw      a0, 0(t0)
        andi    a0, a0, 0xFF
9:      li      t0, HW_SAVE
        sw      a0, 40(t0)
        j       sv_done
sv_exit:
        la      a0, s_exit
        call    puts
        j       halt
sv_exit_code:
        mv      s0, a0
        la      a0, s_exit_code
        call    puts
        mv      a0, s0
        call    put_dec
        la      a0, s_end
        call    puts
        j       halt
sv_done:
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

halt:
        call    usb_flush
1:      wfi
        j       1b

# a1:a0 = SYSTIMER unit 0 counter (latched, then wait until the value is valid)
systimer_read:
        li      t0, SYSTIMER
        li      t1, 1 << 30
        sw      t1, 4(t0)
1:      lw      t1, 4(t0)
        srli    t1, t1, 29
        andi    t1, t1, 1
        beqz    t1, 1b
        lw      a1, 0x40(t0)
        lw      a0, 0x44(t0)
        ret

# ---------------------------------------------------------------- output helpers
# putc(a0): send a byte to UART0 and to USB-Serial-JTAG.
putc:
        li      t0, UART0
1:      lw      t1, 0x1C(t0)
        srli    t1, t1, 16
        andi    t1, t1, 0x3FF                   # TXFIFO_CNT
        li      t2, 126
        bgeu    t1, t2, 1b
        sw      a0, 0(t0)

        li      t0, USB_SERIAL
        li      t3, HW_SAVE
        lw      t2, 128(t3)                     # host stopped reading earlier?
        li      t1, 200000                      # wait budget for a free FIFO slot
        beqz    t2, 2f
        li      t1, 1
2:      lw      t2, 4(t0)
        andi    t2, t2, 2                       # SERIAL_IN_EP_DATA_FREE
        bnez    t2, 3f
        li      t2, 1
        sw      t2, 4(t0)                       # WR_DONE: send what is buffered
        addi    t1, t1, -1
        bnez    t1, 2b
        li      t2, 1
        sw      t2, 128(t3)                     # give up until the host reads again
        ret
3:      sw      zero, 128(t3)
        sw      a0, 0(t0)
        ret

usb_flush:
        li      t0, USB_SERIAL
        li      t1, 1
        sw      t1, 4(t0)
        ret

# puts(a0 = NUL-terminated string; IRAM addresses are read through their DRAM alias)
puts:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s0, 8(sp)
        mv      s0, a0
        li      t1, 0x40000000
        bltu    s0, t1, 1f
        li      t1, IRAM_DRAM_OFFSET
        sub     s0, s0, t1
1:      lbu     a0, 0(s0)
        beqz    a0, 2f
        call    putc
        addi    s0, s0, 1
        j       1b
2:      lw      s0, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# put_dec(a0): unsigned decimal
put_dec:
        addi    sp, sp, -32
        sw      ra, 28(sp)
        sw      s0, 24(sp)
        sw      s1, 20(sp)
        mv      s0, a0
        mv      s1, sp                          # digits are stored at 0..15(sp), reversed
        li      t1, 10
1:      remu    t2, s0, t1
        divu    s0, s0, t1
        addi    t2, t2, 48
        sb      t2, 0(s1)
        addi    s1, s1, 1
        bnez    s0, 1b
2:      addi    s1, s1, -1
        lbu     a0, 0(s1)
        call    putc
        bne     s1, sp, 2b
        lw      s1, 20(sp)
        lw      s0, 24(sp)
        lw      ra, 28(sp)
        addi    sp, sp, 32
        ret

# put_hex(a0): 0x + 8 hex digits
put_hex:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s0, 8(sp)
        sw      s1, 4(sp)
        mv      s0, a0
        li      a0, 48
        call    putc
        li      a0, 120
        call    putc
        li      s1, 8
1:      srli    a0, s0, 28
        li      t1, 10
        bltu    a0, t1, 2f
        addi    a0, a0, 39                      # 'a' - '0' - 10
2:      addi    a0, a0, 48
        call    putc
        slli    s0, s0, 4
        addi    s1, s1, -1
        bnez    s1, 1b
        lw      s1, 4(sp)
        lw      s0, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

s_exc:       .asciz "\\n** Exception: mcause="
s_mepc:      .asciz " mepc="
s_mtval:     .asciz " mtval="
s_end:       .asciz " **\\n"
s_ebreak:    .asciz "\\n** ebreak at "
s_unsup:     .asciz "\\n** Unsupported ecall service a7="
s_exit:      .asciz "\\n** Program exited **\\n"
s_exit_code: .asciz "\\n** Program exited with code "
`;

  const align = (v, a) => Math.ceil(v / a) * a;

  /**
   * Build the firmware for an assembled program (the result of RVAsm.assemble).
   * Returns { image, segments, entry, runtime } or throws an Error with a readable message.
   */
  function buildFirmware(prog) {
    if (!prog || !prog.ok) throw new Error('The program has assembly errors');
    const textEnd = prog.text.base + prog.text.bytes.length;
    const runtimeBase = align(textEnd, RUNTIME_ALIGN);
    const src = RUNTIME_SRC
      .replace('.text', `.equ HW_SAVE, ${HW_SAVE}\n        .equ HW_STACK_TOP, ${HW_STACK_TOP}\n        .equ HW_TRAP_STACK, ${HW_TRAP_STACK}\n` +
        `        .equ USER_ENTRY, ${prog.entry >>> 0}\n        .equ USER_GP, ${prog.data.base >>> 0}\n        .text`);
    const rt = RVAsm.assemble(src, { textBase: runtimeBase });
    if (!rt.ok) throw new Error('Internal error in the hardware runtime: ' + rt.errors.map(e => `line ${e.line}: ${e.message}`).join('; '));
    const runtimeEnd = runtimeBase + rt.text.bytes.length;
    const dataIram = prog.data.base + IRAM_DRAM_OFFSET;
    if (prog.data.bytes.length && runtimeEnd > dataIram) throw new Error('Program code is too large for the hardware build (it overlaps .data)');
    const dataEnd = prog.data.base + prog.data.bytes.length;
    if (dataEnd > HW_STACK_TOP - 4096) throw new Error('.data is too large for the hardware build (it overlaps the stack)');

    const segments = [];
    if (prog.text.bytes.length) segments.push({ addr: prog.text.base, data: prog.text.bytes });
    segments.push({ addr: runtimeBase, data: rt.text.bytes });
    if (prog.data.bytes.length) segments.push({ addr: prog.data.base, data: prog.data.bytes });
    const entry = rt.symbols._hw_start;
    return { image: makeImage(segments, entry), segments, entry, runtime: { base: runtimeBase, size: rt.text.bytes.length } };
  }

  /** Espressif app image: header, extended header, segments, checksum, SHA-256. */
  function makeImage(segments, entry) {
    const parts = [];
    let len = 24;
    const segs = segments.map(s => {
      const data = new Uint8Array(align(s.data.length, 4));
      data.set(s.data);
      len += 8 + data.length;
      return { addr: s.addr, data };
    });
    const total = align(len + 1, 16);                  // checksum byte ends a 16-byte block
    const img = new Uint8Array(total + 32);
    const dv = new DataView(img.buffer);
    img[0] = 0xE9;                                     // magic
    img[1] = segs.length;
    img[2] = 2;                                        // SPI mode: DIO
    img[3] = 0x20;                                     // flash size 4 MB, 40 MHz
    dv.setUint32(4, entry >>> 0, true);
    img[8] = 0xEE;                                     // WP pin: not used
    dv.setUint16(12, CHIP_ID_ESP32C3, true);
    dv.setUint16(15, 0, true);                         // min chip revision (full)
    dv.setUint16(17, 0xFFFF, true);                    // max chip revision (full): no limit
    img[23] = 1;                                       // SHA-256 appended
    let off = 24, chk = 0xEF;
    for (const s of segs) {
      dv.setUint32(off, s.addr >>> 0, true);
      dv.setUint32(off + 4, s.data.length, true);
      img.set(s.data, off + 8);
      for (const b of s.data) chk ^= b;
      off += 8 + s.data.length;
    }
    img[total - 1] = chk;
    img.set(sha256(img.subarray(0, total)), total);
    parts.push(img);
    return img;
  }

  // ---------------------------------------------------------------- SHA-256 (synchronous, small)
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  function sha256(bytes) {
    const n = bytes.length, padded = new Uint8Array(align(n + 9, 64));
    padded.set(bytes);
    padded[n] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(n / 0x20000000), false);
    dv.setUint32(padded.length - 4, (n * 8) >>> 0, false);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, r) => (x >>> r) | (x << (32 - r));
    for (let o = 0; o < padded.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(4 * i, h[i], false);
    return out;
  }

  const Firmware = { buildFirmware, makeImage, sha256, HW_STACK_TOP, RUNTIME_SRC };
  if (isNode) module.exports = Firmware;
  else root.Firmware = Firmware;
})(typeof window !== 'undefined' ? window : globalThis);
