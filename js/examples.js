/* Example projects: source code + parts + wiring. */
(function (root) {
  'use strict';

  const DELAY_MS = `
# ------------------------------------------------------------
# delay_ms(a0 = milliseconds)
# Busy-waits using SYSTIMER unit 0, which counts at 16 MHz
# (16000 ticks per millisecond). Clobbers t0-t4.
# ------------------------------------------------------------
delay_ms:
        li      t0, SYSTIMER_BASE
        li      t1, 16000
        mul     t1, t1, a0              # ticks to wait
        li      t2, 1 << 30             # SYSTIMER_TIMER_UNIT0_UPDATE
        sw      t2, 0x04(t0)            # latch the current counter value
        lw      t3, 0x44(t0)            # SYSTIMER_UNIT0_VALUE_LO
        add     t1, t1, t3              # deadline = now + ticks
1:      sw      t2, 0x04(t0)            # latch again
        lw      t3, 0x44(t0)
        sub     t4, t3, t1
        bltz    t4, 1b                  # loop until now >= deadline
        ret
`;

  const EXAMPLES = [
    {
      id: 'blink',
      name: 'Blink an LED',
      description: 'Toggle an LED on GPIO2 every 500 ms using the GPIO and SYSTIMER registers.',
      code: `# ============================================================
#  Blink - ESP32-C3 / RISC-V assembly
#  Toggles the LED on GPIO2 every 500 ms.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT_W1TS,     0x08     # write 1 = set pin high
        .equ GPIO_OUT_W1TC,     0x0C     # write 1 = set pin low
        .equ GPIO_ENABLE_W1TS,  0x24     # write 1 = make pin an output
        .equ SYSTIMER_BASE,     0x60023000
        .equ LED_PIN,           2

        .text
        .globl main
main:
        li      s0, GPIO_BASE
        li      s1, 1 << LED_PIN        # bit mask of the LED pin
        sw      s1, GPIO_ENABLE_W1TS(s0)

loop:
        sw      s1, GPIO_OUT_W1TS(s0)   # LED on
        li      a0, 500
        call    delay_ms
        sw      s1, GPIO_OUT_W1TC(s0)   # LED off
        li      a0, 500
        call    delay_ms
        j       loop
${DELAY_MS}`,
      components: [
        { id: 'led1', type: 'led', x: 300, y: 90, props: { color: 'red', activeLow: false }, conn: { A: 2 } }
      ]
    },
    {
      id: 'button',
      name: 'Button controls LED',
      description: 'Read a push button on GPIO4 and mirror its state on an LED (GPIO2).',
      code: `# ============================================================
#  Button -> LED
#  The LED (GPIO2) is lit while the button (GPIO4) is pressed.
#  The button connects the pin to GND, so pressed = 0.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT_W1TS,     0x08
        .equ GPIO_OUT_W1TC,     0x0C
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ GPIO_IN,           0x3C     # current level of every pin
        .equ IO_MUX_BASE,       0x60009000
        .equ FUN_WPU,           1 << 8   # weak pull-up
        .equ FUN_IE,            1 << 9   # input enable
        .equ LED_PIN,           2
        .equ BTN_PIN,           4

        .text
main:
        li      s0, GPIO_BASE
        li      s1, 1 << LED_PIN
        li      s2, 1 << BTN_PIN
        sw      s1, GPIO_ENABLE_W1TS(s0)        # LED pin = output

        # IO_MUX_GPIOn_REG: enable input + internal pull-up on the button pin
        li      t0, IO_MUX_BASE + 4 + 4 * BTN_PIN
        li      t1, FUN_IE | FUN_WPU
        sw      t1, 0(t0)

poll:
        lw      t0, GPIO_IN(s0)                 # read all pins
        and     t0, t0, s2                      # isolate the button bit
        beqz    t0, pressed                     # low level = pressed
        sw      s1, GPIO_OUT_W1TC(s0)           # released -> LED off
        j       poll
pressed:
        sw      s1, GPIO_OUT_W1TS(s0)           # pressed  -> LED on
        j       poll
`,
      components: [
        { id: 'led1', type: 'led', x: 300, y: 70, props: { color: 'green', activeLow: false }, conn: { A: 2 } },
        { id: 'btn1', type: 'button', x: 300, y: 250, props: { color: 'red', mode: 'pullup', key: '1' }, conn: { '1': 4 } }
      ]
    },
    {
      id: 'sevenseg',
      name: '7-segment counter',
      description: 'Count 0-9 on a common-cathode 7-segment display wired to GPIO0..GPIO7.',
      code: `# ============================================================
#  7-segment counter: shows 0..9, one digit per second.
#  Segments a,b,c,d,e,f,g,dp are wired to GPIO0..GPIO7
#  (common cathode: a high pin lights the segment).
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT,          0x04
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ SYSTIMER_BASE,     0x60023000
        .equ SEG_MASK,          0xFF

        .data
digits:                         # bit0 = a ... bit6 = g
        .byte   0x3F, 0x06, 0x5B, 0x4F, 0x66
        .byte   0x6D, 0x7D, 0x07, 0x7F, 0x6F

        .text
main:
        li      s0, GPIO_BASE
        li      t0, SEG_MASK
        sw      t0, GPIO_ENABLE_W1TS(s0)    # GPIO0..7 = outputs
        la      s1, digits
        li      s2, 0                       # counter

loop:
        add     t0, s1, s2
        lbu     t1, 0(t0)                   # segment pattern of the digit
        lw      t2, GPIO_OUT(s0)            # read-modify-write so that
        andi    t2, t2, ~SEG_MASK           # other pins keep their state
        or      t2, t2, t1
        sw      t2, GPIO_OUT(s0)

        li      a0, 1000
        call    delay_ms

        addi    s2, s2, 1                   # next digit
        li      t0, 10
        blt     s2, t0, loop
        li      s2, 0
        j       loop
${DELAY_MS}`,
      components: [
        {
          id: 'seg1', type: 'sevenseg', x: 300, y: 120, props: { common: 'cathode', color: 'red' },
          conn: { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 }
        }
      ]
    },
    {
      id: 'counter',
      name: 'Button counter (7-seg)',
      description: 'Count button presses (with debouncing) and show the count on a 7-segment display.',
      code: `# ============================================================
#  Button press counter
#  Every press of the button on GPIO10 increments a counter
#  shown on the 7-segment display (segments on GPIO0..GPIO7).
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT,          0x04
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ GPIO_IN,           0x3C
        .equ IO_MUX_BASE,       0x60009000
        .equ FUN_WPU,           1 << 8   # weak pull-up
        .equ FUN_IE,            1 << 9   # input enable
        .equ SYSTIMER_BASE,     0x60023000
        .equ SEG_MASK,          0xFF
        .equ BTN_PIN,           10

        .data
digits: .byte   0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F

        .text
main:
        li      s0, GPIO_BASE
        li      t0, SEG_MASK
        sw      t0, GPIO_ENABLE_W1TS(s0)
        la      s1, digits
        # IO_MUX_GPIOn_REG: input enable + pull-up (the button connects the pin to GND)
        li      t0, IO_MUX_BASE + 4 + 4 * BTN_PIN
        li      t1, FUN_IE | FUN_WPU
        sw      t1, 0(t0)
        li      s2, 0                   # count
        li      s3, 1 << BTN_PIN
        li      s4, 1                   # previous button level (1 = released)

loop:
        mv      a0, s2
        call    show_digit

        lw      t0, GPIO_IN(s0)
        and     t0, t0, s3
        snez    t0, t0                  # t0 = current level (0 = pressed)
        beq     t0, s4, loop            # no change
        mv      s4, t0
        bnez    t0, debounce            # rising edge (release): just debounce

        addi    s2, s2, 1               # falling edge (press): count it
        li      t1, 10
        blt     s2, t1, debounce
        li      s2, 0
debounce:
        li      a0, 20                  # ignore contact bounce for 20 ms
        call    delay_ms
        j       loop

# show_digit(a0 = 0..9)
show_digit:
        add     t0, s1, a0
        lbu     t1, 0(t0)
        lw      t2, GPIO_OUT(s0)
        andi    t2, t2, ~SEG_MASK
        or      t2, t2, t1
        sw      t2, GPIO_OUT(s0)
        ret
${DELAY_MS}`,
      components: [
        {
          id: 'seg1', type: 'sevenseg', x: 300, y: 60, props: { common: 'cathode', color: 'green' },
          conn: { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 }
        },
        { id: 'btn1', type: 'button', x: 320, y: 270, props: { color: 'blue', mode: 'pullup', key: ' ' }, conn: { '1': 10 } }
      ]
    },
    {
      id: 'traffic',
      name: 'Traffic light',
      description: 'Table-driven traffic light sequence on three LEDs (GPIO3, GPIO4, GPIO5).',
      code: `# ============================================================
#  Traffic light - a table-driven state machine.
#  Red = GPIO3, Yellow = GPIO4, Green = GPIO5
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT,          0x04
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ SYSTIMER_BASE,     0x60023000
        .equ RED,               1 << 3
        .equ YELLOW,            1 << 4
        .equ GREEN,             1 << 5
        .equ ALL,               RED | YELLOW | GREEN

        .data
        .align  2
states: #       lights          duration (ms)
        .word   GREEN,          3000
        .word   YELLOW,         1000
        .word   RED,            3000
        .word   RED | YELLOW,   800
states_end:

        .text
main:
        li      s0, GPIO_BASE
        li      t0, ALL
        sw      t0, GPIO_ENABLE_W1TS(s0)

restart:
        la      s1, states              # s1 = current table entry
next:
        lw      t1, 0(s1)               # lights for this state
        lw      t2, GPIO_OUT(s0)
        andi    t2, t2, ~ALL
        or      t2, t2, t1
        sw      t2, GPIO_OUT(s0)

        lw      a0, 4(s1)               # how long to stay
        call    delay_ms

        addi    s1, s1, 8               # advance to next entry
        la      t0, states_end
        bltu    s1, t0, next
        j       restart
${DELAY_MS}`,
      components: [
        { id: 'led1', type: 'led', x: 300, y: 60, props: { color: 'red', activeLow: false }, conn: { A: 3 } },
        { id: 'led2', type: 'led', x: 370, y: 60, props: { color: 'yellow', activeLow: false }, conn: { A: 4 } },
        { id: 'led3', type: 'led', x: 440, y: 60, props: { color: 'green', activeLow: false }, conn: { A: 5 } }
      ]
    },
    {
      id: 'uart',
      name: 'UART hello + echo',
      description: 'Print a greeting through the UART0 FIFO register and echo what you type in the serial monitor.',
      code: `# ============================================================
#  UART0: print a greeting, then echo every received character.
#  Type in the Serial Monitor input box and press Enter.
# ============================================================
        .equ UART0_BASE,        0x60000000
        .equ UART_FIFO,         0x00
        .equ UART_STATUS,       0x1C     # [9:0] RX count, [25:16] TX count
        .equ GPIO_BASE,         0x60004000
        .equ LED_PIN,           2

        .data
hello:  .asciz  "Hello from ESP32-C3 (RISC-V)!\\nType something in the serial monitor:\\n"

        .text
main:
        li      t0, GPIO_BASE           # LED on GPIO2 flashes on every char
        li      t1, 1 << LED_PIN
        sw      t1, 0x24(t0)

        la      a0, hello
        call    uart_puts
echo:
        call    uart_getc               # a0 = received character
        li      t0, GPIO_BASE
        li      t1, 1 << LED_PIN
        lw      t2, 0x04(t0)
        xor     t2, t2, t1              # toggle the LED
        sw      t2, 0x04(t0)
        call    uart_putc
        j       echo

# uart_putc(a0 = character)
uart_putc:
        li      t0, UART0_BASE
1:      lw      t1, UART_STATUS(t0)
        srli    t1, t1, 16
        andi    t1, t1, 0x3FF           # TXFIFO_CNT
        li      t2, 126
        bgeu    t1, t2, 1b              # wait while the TX FIFO is full
        sw      a0, UART_FIFO(t0)
        ret

# uart_getc() -> a0 (blocks until a character arrives)
uart_getc:
        li      t0, UART0_BASE
1:      lw      t1, UART_STATUS(t0)
        andi    t1, t1, 0x3FF           # RXFIFO_CNT
        beqz    t1, 1b
        lw      a0, UART_FIFO(t0)
        andi    a0, a0, 0xFF
        ret

# uart_puts(a0 = pointer to NUL-terminated string)
uart_puts:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s0, 8(sp)
        mv      s0, a0
2:      lbu     a0, 0(s0)
        beqz    a0, 3f
        call    uart_putc
        addi    s0, s0, 1
        j       2b
3:      lw      s0, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret
`,
      components: [
        { id: 'led1', type: 'led', x: 300, y: 90, props: { color: 'blue', activeLow: false }, conn: { A: 2 } }
      ]
    },
    {
      id: 'syscalls',
      name: 'Fibonacci (simulator ecalls)',
      description: 'Uses simulator-only ecall services (print, sleep, exit) to print Fibonacci numbers.',
      code: `# ============================================================
#  Fibonacci numbers using the simulator's ecall services
#  (RARS-style: a7 = service number, a0 = argument).
#  NOTE: these services only exist in the simulator - real
#  hardware has no OS to answer an ecall.
#
#    a7 = 1  print int      a7 = 4  print string
#    a7 = 11 print char     a7 = 32 sleep a0 ms
#    a7 = 93 exit(a0)
# ============================================================
        .data
title:  .asciz  "First 25 Fibonacci numbers:\\n"

        .text
main:
        la      a0, title
        li      a7, 4
        ecall

        li      s0, 0           # F(n)
        li      s1, 1           # F(n+1)
        li      s2, 25          # how many to print
loop:
        mv      a0, s0
        li      a7, 1           # print int
        ecall
        li      a0, '\\n'
        li      a7, 11          # print char
        ecall
        li      a0, 100
        li      a7, 32          # sleep 100 ms
        ecall

        add     t0, s0, s1
        mv      s0, s1
        mv      s1, t0
        addi    s2, s2, -1
        bnez    s2, loop

        li      a0, 0
        li      a7, 93          # exit(0)
        ecall
`,
      components: []
    }
  ];

  const BLANK = `# ESP32-C3 RISC-V assembly program
        .equ GPIO_BASE, 0x60004000

        .data
# your variables here

        .text
        .globl main
main:
        # your code here

done:
        j       done
`;

  const out = { EXAMPLES, BLANK };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else Object.assign(root, out);
})(typeof window !== 'undefined' ? window : globalThis);
