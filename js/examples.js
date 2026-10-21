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

  // GPIO4..7 power up in IO MUX function 0 (JTAG: MTMS, MTDI, MTCK, MTDO), where GPIO_OUT
  // does not reach the pin. Select function 1 (GPIOn) for pins first..last.
  const GPIO_FUNC = (first, last) => `
        # GPIO${first}..${last} start in IO MUX function 0 (JTAG). Select function 1
        # (GPIOn) in MCU_SEL (bits 14:12) of IO_MUX_GPIOn_REG.
        li      t0, IO_MUX_BASE + 4 + 4 * ${first}  # IO_MUX_GPIO${first}_REG
        addi    t1, t0, 4 * ${last - first + 1}
        li      t3, ~MCU_SEL_MASK
        li      t4, MCU_SEL_GPIO
1:      lw      t2, 0(t0)
        and     t2, t2, t3
        or      t2, t2, t4
        sw      t2, 0(t0)
        addi    t0, t0, 4
        bltu    t0, t1, 1b
`;
  const MCU_SEL_EQU = `        .equ IO_MUX_BASE,       0x60009000
        .equ MCU_SEL_MASK,      7 << 12  # IO MUX function select
        .equ MCU_SEL_GPIO,      1 << 12  # function 1 = GPIOn
`;

  // Lab board (BOARDS.labc3) push buttons PB1..PB4 on GPIO9, 10, 20, 21.
  const LAB_BUTTONS_EQU = `        .equ FUN_WPU,           1 << 8   # weak pull-up
        .equ FUN_IE,            1 << 9   # input enable
        .equ PB1,               1 << 9
        .equ PB2,               1 << 10
        .equ PB3,               1 << 20
        .equ PB4,               1 << 21
        .equ PB_ALL,            PB1 | PB2 | PB3 | PB4
`;
  const LAB_BUTTONS_SETUP = `
        # PB1..PB4: function 1 (GPIOn), input enable, pull-up (jumper PB adds
        # 10k pull-ups too). GPIO20/21 start as U0RXD/U0TXD, and U0TXD drives
        # GPIO21 HIGH, so they must be switched to GPIO before PB3/PB4 work.
        li      t1, MCU_SEL_GPIO | FUN_IE | FUN_WPU
        li      t0, IO_MUX_BASE + 4 + 4 * 9
        sw      t1, 0(t0)                   # IO_MUX_GPIO9_REG
        sw      t1, 4(t0)                   # IO_MUX_GPIO10_REG
        li      t0, IO_MUX_BASE + 4 + 4 * 20
        sw      t1, 0(t0)                   # IO_MUX_GPIO20_REG
        sw      t1, 4(t0)                   # IO_MUX_GPIO21_REG
        li      s5, 0                       # buttons down at the last check
`;
  const LAB_NEW_PRESSES = `
# ------------------------------------------------------------
# new_presses() -> a0 = mask of the buttons pressed since the
# last call (s5 = buttons down at the last call). A button reads
# LOW while pressed. Calling it every 10 ms also debounces.
# ------------------------------------------------------------
new_presses:
        lw      t0, GPIO_IN(s0)
        not     t0, t0
        li      t1, PB_ALL
        and     t0, t0, t1                  # buttons down now
        not     a0, s5
        and     a0, a0, t0                  # down now, up last time
        mv      s5, t0
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
${MCU_SEL_EQU}        .equ SEG_MASK,          0xFF

        .data
digits:                         # bit0 = a ... bit6 = g
        .byte   0x3F, 0x06, 0x5B, 0x4F, 0x66
        .byte   0x6D, 0x7D, 0x07, 0x7F, 0x6F

        .text
main:
        li      s0, GPIO_BASE
        li      t0, SEG_MASK
        sw      t0, GPIO_ENABLE_W1TS(s0)    # GPIO0..7 = outputs
${GPIO_FUNC(4, 7)}        la      s1, digits
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
${MCU_SEL_EQU}        .equ FUN_WPU,           1 << 8   # weak pull-up
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
${GPIO_FUNC(4, 7)}        la      s1, digits
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
${MCU_SEL_EQU}        .equ RED,               1 << 3
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
${GPIO_FUNC(4, 5)}
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
      description: 'Print a greeting through the UART0 FIFO register and echo what you type in the serial monitor. (On a SuperMini or XIAO ESP32C3, UART0 is on GPIO20/21, not on USB: use the USB-Serial-JTAG example there.)',
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
      name: 'Fibonacci (ecall services)',
      description: 'Uses the ecall services (print, sleep, exit) to print Fibonacci numbers.',
      code: `# ============================================================
#  Fibonacci numbers using the simulator's ecall services
#  (RARS-style: a7 = service number, a0 = argument).
#  Real hardware has no OS to answer an ecall: Hardware ▸ Run on
#  board adds a small runtime that implements them over USB / UART.
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
    },
    {
      id: 'mini-blink',
      board: 'supermini',
      name: 'SuperMini: blink the on-board LED',
      description: 'Blink the blue LED on GPIO8 (lit when the pin is LOW) and report it on the serial monitor. Try it on a real board with Hardware ▸ Run on board.',
      code: `# ============================================================
#  ESP32-C3 SuperMini: blink the on-board blue LED.
#  The LED sits between 3V3 and GPIO8, so it lights up when
#  GPIO8 is driven LOW (active low).
#  Runs in the simulator and on a real board (Hardware menu).
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT_W1TS,     0x08
        .equ GPIO_OUT_W1TC,     0x0C
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ SYSTIMER_BASE,     0x60023000
        .equ LED_PIN,           8

        .data
msg_on:  .asciz "LED on\\n"
msg_off: .asciz "LED off\\n"

        .text
main:
        li      s0, GPIO_BASE
        li      s1, 1 << LED_PIN
        sw      s1, GPIO_OUT_W1TS(s0)   # start with the LED off (pin HIGH)
        sw      s1, GPIO_ENABLE_W1TS(s0)

loop:
        sw      s1, GPIO_OUT_W1TC(s0)   # pin LOW  -> LED on
        la      a0, msg_on
        li      a7, 4                   # ecall: print string
        ecall
        li      a0, 500
        call    delay_ms

        sw      s1, GPIO_OUT_W1TS(s0)   # pin HIGH -> LED off
        la      a0, msg_off
        li      a7, 4
        ecall
        li      a0, 500
        call    delay_ms
        j       loop
${DELAY_MS}`,
      components: []
    },
    {
      id: 'mini-boot',
      board: 'supermini',
      name: 'SuperMini: BOOT button toggles the LED',
      description: 'Each press of the BOOT button (GPIO9) toggles the on-board LED (GPIO8) and prints a press counter.',
      code: `# ============================================================
#  BOOT button (GPIO9, LOW while pressed) toggles the on-board
#  LED (GPIO8, active low). Presses are counted and printed.
#  In the simulator, click the BOOT button on the board.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT,          0x04
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ GPIO_IN,           0x3C
        .equ IO_MUX_BASE,       0x60009000
        .equ FUN_WPU,           1 << 8
        .equ FUN_IE,            1 << 9
        .equ SYSTIMER_BASE,     0x60023000
        .equ LED_PIN,           8
        .equ BTN_PIN,           9

        .data
msg:    .asciz "BOOT pressed: "

        .text
main:
        li      s0, GPIO_BASE
        li      s1, 1 << LED_PIN
        li      s2, 1 << BTN_PIN
        sw      s1, GPIO_OUT(s0)        # LED off (pin HIGH)
        sw      s1, GPIO_ENABLE_W1TS(s0)
        li      t0, IO_MUX_BASE + 4 + 4 * BTN_PIN
        li      t1, FUN_IE | FUN_WPU    # input + pull-up (already so after reset)
        sw      t1, 0(t0)
        li      s3, 0                   # press count

wait_press:
        lw      t0, GPIO_IN(s0)
        and     t0, t0, s2
        bnez    t0, wait_press          # HIGH = released
        lw      t0, GPIO_OUT(s0)
        xor     t0, t0, s1              # toggle the LED
        sw      t0, GPIO_OUT(s0)
        addi    s3, s3, 1
        la      a0, msg
        li      a7, 4
        ecall
        mv      a0, s3
        li      a7, 1                   # print int
        ecall
        li      a0, '\\n'
        li      a7, 11                  # print char
        ecall
        li      a0, 30                  # debounce
        call    delay_ms
wait_release:
        lw      t0, GPIO_IN(s0)
        and     t0, t0, s2
        beqz    t0, wait_release
        li      a0, 30
        call    delay_ms
        j       wait_press
${DELAY_MS}`,
      components: []
    },
    {
      id: 'usb-echo',
      board: 'supermini',
      name: 'USB-Serial-JTAG hello + echo',
      description: 'Talk to the computer through the USB-Serial-JTAG registers (the SuperMini\'s USB-C port): print a greeting and echo what you type.',
      code: `# ============================================================
#  USB-Serial-JTAG: the ESP32-C3's built-in USB serial port
#  (the USB-C connector of the SuperMini).
#    EP1      (+0x00): write = send a byte, read = received byte
#    EP1_CONF (+0x04): bit 0 WR_DONE (write 1: send the buffered
#                      bytes now), bit 1 IN_EP_DATA_FREE (room to
#                      send), bit 2 OUT_EP_DATA_AVAIL (byte received)
#  Type in the serial monitor: each line is echoed in upper case.
# ============================================================
        .equ USB_SERIAL,        0x60043000
        .equ EP1,               0x00
        .equ EP1_CONF,          0x04
        .equ WR_DONE,           1 << 0
        .equ DATA_FREE,         1 << 1
        .equ DATA_AVAIL,        1 << 2

        .data
hello:  .asciz  "Hello over USB-Serial-JTAG! Type something:\\n"

        .text
main:
        la      a0, hello
        call    usb_puts
        call    usb_flush
echo:
        call    usb_getc                # a0 = received byte
        li      t0, 'a'                 # a..z -> A..Z
        blt     a0, t0, 1f
        li      t0, 'z'
        bgt     a0, t0, 1f
        addi    a0, a0, -32
1:      call    usb_putc
        li      t0, '\\n'
        bne     a0, t0, echo
        call    usb_flush               # send each line as soon as it ends
        j       echo

# usb_putc(a0): wait for room in the FIFO, then queue the byte
usb_putc:
        li      t0, USB_SERIAL
1:      lw      t1, EP1_CONF(t0)
        andi    t1, t1, DATA_FREE
        bnez    t1, 2f
        li      t1, WR_DONE             # FIFO full: send it
        sw      t1, EP1_CONF(t0)
        j       1b
2:      sw      a0, EP1(t0)
        ret

# usb_flush(): send the bytes queued so far
usb_flush:
        li      t0, USB_SERIAL
        li      t1, WR_DONE
        sw      t1, EP1_CONF(t0)
        ret

# usb_getc() -> a0: wait for a received byte
usb_getc:
        li      t0, USB_SERIAL
1:      lw      t1, EP1_CONF(t0)
        andi    t1, t1, DATA_AVAIL
        beqz    t1, 1b
        lw      a0, EP1(t0)
        andi    a0, a0, 0xFF
        ret

# usb_puts(a0 = NUL-terminated string)
usb_puts:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s0, 8(sp)
        mv      s0, a0
1:      lbu     a0, 0(s0)
        beqz    a0, 2f
        call    usb_putc
        addi    s0, s0, 1
        j       1b
2:      lw      s0, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret
`,
      components: []
    },

    {
      id: 'matrix',
      name: 'LED matrix (MAX7219)',
      description: 'Bit-bang the MAX7219 serial interface (DIN, CS, CLK) to set up an 8×8 LED matrix module and alternate between two pictures.',
      code: `# ============================================================
#  8x8 LED matrix with a MAX7219 driver.
#  Each transfer is 16 bits, MSB first: 4 don't-care bits, a
#  4-bit register address, 8 data bits. The MAX7219 shifts DIN
#  in on each rising edge of CLK and latches the word when CS
#  goes high. Digit registers 1..8 hold rows 0..7 (top to
#  bottom); bit 7 is the leftmost LED of a row.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT_W1TS,     0x08
        .equ GPIO_OUT_W1TC,     0x0C
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ SYSTIMER_BASE,     0x60023000
        .equ DIN_PIN,           2
        .equ CS_PIN,            3
        .equ CLK_PIN,           10

        # MAX7219 registers
        .equ REG_DECODE,        0x09
        .equ REG_INTENSITY,     0x0A
        .equ REG_SCAN_LIMIT,    0x0B
        .equ REG_SHUTDOWN,      0x0C
        .equ REG_TEST,          0x0F

        .data
heart:     .byte 0x00, 0x66, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C, 0x18
smiley:    .byte 0x3C, 0x42, 0xA5, 0x81, 0xA5, 0x99, 0x42, 0x3C
msg_heart: .asciz "heart\\n"
msg_smile: .asciz "smiley\\n"

        .text
main:
        li      s0, GPIO_BASE
        li      t0, 1 << CS_PIN
        sw      t0, GPIO_OUT_W1TS(s0)   # CS idles HIGH
        li      t0, (1 << DIN_PIN) | (1 << CS_PIN) | (1 << CLK_PIN)
        sw      t0, GPIO_ENABLE_W1TS(s0)

        # The MAX7219 powers up in shutdown: configure it, then turn it on.
        li      a0, REG_TEST
        li      a1, 0                   # display test off
        call    max_write
        li      a0, REG_DECODE
        li      a1, 0                   # no BCD decoding: raw LED patterns
        call    max_write
        li      a0, REG_SCAN_LIMIT
        li      a1, 7                   # show all 8 rows
        call    max_write
        li      a0, REG_INTENSITY
        li      a1, 4                   # brightness 0..15
        call    max_write
        li      a0, REG_SHUTDOWN
        li      a1, 1                   # normal operation
        call    max_write

loop:
        la      a0, heart
        call    show
        la      a0, msg_heart
        li      a7, 4                   # ecall: print string
        ecall
        li      a0, 700
        call    delay_ms

        la      a0, smiley
        call    show
        la      a0, msg_smile
        li      a7, 4
        ecall
        li      a0, 700
        call    delay_ms
        j       loop

# ------------------------------------------------------------
# show(a0 = address of 8 row bytes): write rows 0..7 to digit
# registers 1..8.
# ------------------------------------------------------------
show:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s1, 8(sp)
        sw      s2, 4(sp)
        mv      s1, a0
        li      s2, 1                   # digit register 1 = top row
1:      mv      a0, s2
        lbu     a1, 0(s1)
        call    max_write
        addi    s1, s1, 1
        addi    s2, s2, 1
        li      t0, 9
        blt     s2, t0, 1b
        lw      s2, 4(sp)
        lw      s1, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# ------------------------------------------------------------
# max_write(a0 = register, a1 = data): send one 16-bit word.
# Uses s0 = GPIO_BASE. Clobbers t0-t5.
# ------------------------------------------------------------
max_write:
        slli    t0, a0, 8
        or      t0, t0, a1              # word = register << 8 | data
        li      t1, 1 << CS_PIN
        li      t2, 1 << CLK_PIN
        li      t5, 1 << DIN_PIN
        sw      t1, GPIO_OUT_W1TC(s0)   # CS LOW: start of the word
        li      t3, 16                  # bits to send, MSB first
1:      sw      t2, GPIO_OUT_W1TC(s0)   # CLK LOW
        srli    t4, t0, 15
        andi    t4, t4, 1
        beqz    t4, 2f
        sw      t5, GPIO_OUT_W1TS(s0)   # DIN = 1
        j       3f
2:      sw      t5, GPIO_OUT_W1TC(s0)   # DIN = 0
3:      sw      t2, GPIO_OUT_W1TS(s0)   # CLK HIGH: the MAX7219 reads DIN
        slli    t0, t0, 1
        addi    t3, t3, -1
        bnez    t3, 1b
        sw      t2, GPIO_OUT_W1TC(s0)   # CLK LOW
        sw      t1, GPIO_OUT_W1TS(s0)   # CS HIGH: latch the word
        ret
${DELAY_MS}`,
      components: [
        { id: 'mx1', type: 'matrix', x: 300, y: 120, props: { modules: '1', color: 'red', vcc: '5V' }, conn: { DIN: 2, CS: 3, CLK: 10 } }
      ]
    },
    {
      id: 'rgb',
      name: 'RGB LED colour wheel',
      description: 'Software PWM on three GPIOs fades a common-cathode RGB LED around the colour wheel: red, green, blue and every mix in between.',
      code: `# ============================================================
#  RGB LED colour wheel with software PWM.
#  Each PWM period has 256 steps; a colour's pin is HIGH while
#  the step is below its duty (0..255), so its LED is on for
#  duty/256 of the time. The wheel has 768 positions: red fades
#  to green, green to blue, blue back to red.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT,          0x04
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ R_PIN,             2
        .equ G_PIN,             3
        .equ B_PIN,             10
        .equ PERIODS,           250      # PWM periods per wheel position (speed)

        .text
main:
        li      s0, GPIO_BASE
        li      t0, (1 << R_PIN) | (1 << G_PIN) | (1 << B_PIN)
        sw      t0, GPIO_ENABLE_W1TS(s0)
        li      s4, 0                   # position on the wheel, 0..767

wheel:
        # s1, s2, s3 = red, green, blue duty (0..255) at position s4
        andi    t0, s4, 255             # step within the current third
        li      t1, 255
        sub     t1, t1, t0              # 255 - step
        srli    t2, s4, 8               # which third: 0, 1 or 2
        li      s1, 0
        li      s2, 0
        li      s3, 0
        beqz    t2, 1f
        li      t3, 1
        beq     t2, t3, 2f
        mv      s3, t1                  # third 2: blue -> red
        mv      s1, t0
        j       3f
1:      mv      s1, t1                  # third 0: red -> green
        mv      s2, t0
        j       3f
2:      mv      s2, t1                  # third 1: green -> blue
        mv      s3, t0
3:      li      s5, PERIODS
4:      call    pwm_period
        addi    s5, s5, -1
        bnez    s5, 4b
        addi    s4, s4, 1
        li      t0, 768
        bltu    s4, t0, wheel
        li      s4, 0
        j       wheel

# ------------------------------------------------------------
# pwm_period: one PWM period of 256 steps with duties s1, s2, s3.
# Every step takes the same number of instructions (no branches
# per colour), so the time a pin is HIGH matches its duty.
# Uses s0 = GPIO_BASE. Clobbers t0, t1, t2, t5.
# ------------------------------------------------------------
pwm_period:
        li      t0, 0                   # step
        li      t5, 256
1:      sltu    t1, t0, s1              # 1 while step < red duty
        slli    t1, t1, R_PIN
        sltu    t2, t0, s2
        slli    t2, t2, G_PIN
        or      t1, t1, t2
        sltu    t2, t0, s3
        slli    t2, t2, B_PIN
        or      t1, t1, t2
        sw      t1, GPIO_OUT(s0)
        addi    t0, t0, 1
        bltu    t0, t5, 1b
        ret
`,
      components: [
        { id: 'rgb1', type: 'rgbled', x: 300, y: 100, props: { common: 'cathode' }, conn: { R: 2, G: 3, B: 10 } }
      ]
    },
    {
      id: 'tm1637',
      name: '4-digit clock (TM1637)',
      description: 'Bit-bang the TM1637 two-wire protocol (CLK, DIO with ACK) to count minutes and seconds on a 4-digit display with a blinking colon.',
      code: `# ============================================================
#  MM:SS clock on a 4-digit TM1637 display module.
#  The TM1637 protocol: start = DIO falls while CLK is HIGH,
#  stop = DIO rises while CLK is HIGH; bytes go LSB first, DIO
#  is read on each rising CLK edge, and after 8 bits the chip
#  pulls DIO LOW for one clock (ACK).
#  Both lines are driven open-drain: GPIO_OUT stays 0, enabling
#  the output pulls the line LOW, disabling it lets the module's
#  pull-up take it HIGH. That way the chip can drive DIO for the
#  ACK, which we read through GPIO_IN.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT_W1TC,     0x0C
        .equ GPIO_ENABLE_W1TS,  0x24     # pull LOW
        .equ GPIO_ENABLE_W1TC,  0x28     # release (HIGH)
        .equ GPIO_IN,           0x3C
        .equ IO_MUX_BASE,       0x60009000
        .equ FUN_WPU,           1 << 8   # weak pull-up
        .equ FUN_IE,            1 << 9   # input enable
        .equ SYSTIMER_BASE,     0x60023000
        .equ CLK_PIN,           2
        .equ DIO_PIN,           3

        # TM1637 commands
        .equ CMD_DATA,          0x40     # write display registers, auto-increment
        .equ CMD_ADDR,          0xC0     # + digit: where the data bytes go
        .equ CMD_DISPLAY,       0x88     # display on + brightness 0..7

        .data
font:     .byte 0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F
digits:   .byte 0, 0, 0, 0
no_ack:   .asciz "No ACK from the TM1637: check its wiring and power.\\n"

        .text
main:
        li      s0, GPIO_BASE
        li      s1, 1 << CLK_PIN
        li      s2, 1 << DIO_PIN
        or      t0, s1, s2
        sw      t0, GPIO_OUT_W1TC(s0)   # an enabled line is LOW

        # Input buffer + weak pull-up on DIO (to read the ACK), pull-up on CLK.
        li      t0, IO_MUX_BASE + 4 + 4 * DIO_PIN
        lw      t1, 0(t0)
        ori     t1, t1, FUN_IE | FUN_WPU
        sw      t1, 0(t0)
        li      t0, IO_MUX_BASE + 4 + 4 * CLK_PIN
        lw      t1, 0(t0)
        ori     t1, t1, FUN_WPU
        sw      t1, 0(t0)

        call    tm_start                # turn the display on, check the ACK
        li      a0, CMD_DISPLAY | 4
        call    tm_byte
        mv      s5, a0
        call    tm_stop
        beqz    s5, 1f
        la      a0, no_ack
        li      a7, 4                   # ecall: print string
        ecall

1:      li      s3, 0                   # seconds since the start
        li      s4, 0                   # half second: 0 = colon on, 1 = off
loop:
        call    show_time
        li      a0, 500
        call    delay_ms
        xori    s4, s4, 1
        bnez    s4, loop
        addi    s3, s3, 1               # a whole second has passed
        li      t0, 6000                # 99:59 -> 00:00
        bltu    s3, t0, loop
        li      s3, 0
        j       loop

# ------------------------------------------------------------
# show_time: write MM:SS (s3 seconds) to the 4 digits, with the
# colon (bit 7 of digit 1) lit while s4 = 0.
# ------------------------------------------------------------
show_time:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s6, 8(sp)
        li      t0, 60
        divu    t1, s3, t0              # minutes
        remu    t2, s3, t0              # seconds
        li      t0, 10
        la      t3, font
        la      s6, digits
        divu    t4, t1, t0              # tens of minutes
        add     t4, t3, t4
        lbu     t4, 0(t4)
        sb      t4, 0(s6)
        remu    t4, t1, t0              # minutes
        add     t4, t3, t4
        lbu     t4, 0(t4)
        seqz    t5, s4
        slli    t5, t5, 7               # colon
        or      t4, t4, t5
        sb      t4, 1(s6)
        divu    t4, t2, t0              # tens of seconds
        add     t4, t3, t4
        lbu     t4, 0(t4)
        sb      t4, 2(s6)
        remu    t4, t2, t0              # seconds
        add     t4, t3, t4
        lbu     t4, 0(t4)
        sb      t4, 3(s6)

        call    tm_start
        li      a0, CMD_DATA
        call    tm_byte
        call    tm_stop
        call    tm_start
        li      a0, CMD_ADDR            # digit 0, then 1, 2, 3
        call    tm_byte
        lbu     a0, 0(s6)
        call    tm_byte
        lbu     a0, 1(s6)
        call    tm_byte
        lbu     a0, 2(s6)
        call    tm_byte
        lbu     a0, 3(s6)
        call    tm_byte
        call    tm_stop

        lw      s6, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# ------------------------------------------------------------
# tm_start / tm_stop: start and stop conditions. Both lines are
# HIGH between transfers; CLK is LOW after tm_start.
# ------------------------------------------------------------
tm_start:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s2, GPIO_ENABLE_W1TS(s0)    # DIO LOW while CLK is HIGH
        call    tm_delay
        sw      s1, GPIO_ENABLE_W1TS(s0)    # CLK LOW
        call    tm_delay
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

tm_stop:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s2, GPIO_ENABLE_W1TS(s0)    # DIO LOW
        call    tm_delay
        sw      s1, GPIO_ENABLE_W1TC(s0)    # CLK HIGH
        call    tm_delay
        sw      s2, GPIO_ENABLE_W1TC(s0)    # DIO HIGH while CLK is HIGH
        call    tm_delay
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# ------------------------------------------------------------
# tm_byte(a0 = byte) -> a0 = 0 if the TM1637 acknowledged it.
# Sends 8 bits LSB first, then clocks the ACK bit in.
# ------------------------------------------------------------
tm_byte:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s7, 8(sp)
        sw      s8, 4(sp)
        mv      s7, a0
        li      s8, 8
1:      andi    t0, s7, 1
        beqz    t0, 2f
        sw      s2, GPIO_ENABLE_W1TC(s0)    # bit 1: release DIO
        j       3f
2:      sw      s2, GPIO_ENABLE_W1TS(s0)    # bit 0: DIO LOW
3:      call    tm_delay
        sw      s1, GPIO_ENABLE_W1TC(s0)    # CLK HIGH: the chip reads DIO
        call    tm_delay
        sw      s1, GPIO_ENABLE_W1TS(s0)    # CLK LOW
        srli    s7, s7, 1
        addi    s8, s8, -1
        bnez    s8, 1b

        sw      s2, GPIO_ENABLE_W1TC(s0)    # release DIO: the chip pulls it LOW
        call    tm_delay
        sw      s1, GPIO_ENABLE_W1TC(s0)    # 9th clock
        call    tm_delay
        lw      s7, GPIO_IN(s0)
        srli    s7, s7, DIO_PIN
        andi    s7, s7, 1               # ACK = 0
        sw      s1, GPIO_ENABLE_W1TS(s0)    # CLK LOW: the chip releases DIO
        call    tm_delay
        mv      a0, s7
        lw      s8, 4(sp)
        lw      s7, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# tm_delay: about 4 us at 160 MHz, so CLK stays well below the
# TM1637's maximum clock rate. Clobbers t6.
tm_delay:
        li      t6, 320
1:      addi    t6, t6, -1
        bnez    t6, 1b
        ret
${DELAY_MS}`,
      components: [
        { id: 'tm1', type: 'tm1637', x: 300, y: 120, props: { points: 'colon', color: 'red', vcc: '3V3' }, conn: { CLK: 2, DIO: 3 } }
      ]
    },
    {
      id: 'lcd',
      name: 'LCD1602, 4-bit parallel (7 wires)',
      description: 'Drive a 16×2 character LCD over RS, RW, E and D4–D7: the 4-bit set-up, busy-flag polling, a custom character and a counter.',
      code: `# ============================================================
#  LCD1602 (HD44780 controller) in 4-bit mode, 7 wires:
#  RS, RW, E and D4..D7. The controller latches a nibble on the
#  falling edge of E. After power-up it is in 8-bit mode, so the
#  4-bit set-up sends the nibble 3 three times, then 2; after
#  that every byte is two nibbles, high first. Before each byte
#  we read the busy flag (D7 with RS = 0, RW = 1) and wait until
#  the controller has finished the previous one.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT_W1TS,     0x08
        .equ GPIO_OUT_W1TC,     0x0C
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ GPIO_ENABLE_W1TC,  0x28
        .equ GPIO_IN,           0x3C
        .equ IO_MUX_BASE,       0x60009000
        .equ MCU_SEL_MASK,      7 << 12  # IO MUX function select
        .equ MCU_SEL_GPIO,      1 << 12  # function 1 = GPIOn
        .equ FUN_IE,            1 << 9   # input enable
        .equ SYSTIMER_BASE,     0x60023000
        .equ RS,                1 << 0   # GPIO0
        .equ RW,                1 << 1   # GPIO1
        .equ E,                 1 << 2   # GPIO2
        .equ DATA_SHIFT,        4        # D4..D7 on GPIO4..7
        .equ DATA,              0xF << DATA_SHIFT
        .equ BUSY,              1 << 7   # busy flag on D7 = GPIO7

        .data
line1:  .asciz "Hello, ESP32-C3!"
line2:  .asciz "Count:"
heart:  .byte 0x00, 0x0A, 0x1F, 0x1F, 0x0E, 0x04, 0x00, 0x00

        .text
main:
        li      s0, GPIO_BASE
        # GPIO4..7 start in IO MUX function 0 (JTAG): select function 1
        # (GPIOn) and turn the input buffer on to read the busy flag.
        li      t0, IO_MUX_BASE + 4 + 4 * 4     # IO_MUX_GPIO4_REG
        li      t1, IO_MUX_BASE + 4 + 4 * 8
        li      t3, ~MCU_SEL_MASK
        li      t4, MCU_SEL_GPIO | FUN_IE
1:      lw      t2, 0(t0)
        and     t2, t2, t3
        or      t2, t2, t4
        sw      t2, 0(t0)
        addi    t0, t0, 4
        bltu    t0, t1, 1b

        li      t0, RS | RW | E | DATA
        sw      t0, GPIO_OUT_W1TC(s0)   # all LOW
        sw      t0, GPIO_ENABLE_W1TS(s0)

        # 4-bit set-up. The busy flag can't be read yet: use delays.
        li      a0, 50
        call    delay_ms                # > 15 ms after power-up (40 ms at 3.3 V)
        li      a0, 3
        call    lcd_nibble
        li      a0, 5
        call    delay_ms                # > 4.1 ms
        li      a0, 3
        call    lcd_nibble
        li      a0, 1
        call    delay_ms                # > 100 us
        li      a0, 3
        call    lcd_nibble
        li      a0, 1
        call    delay_ms
        li      a0, 2                   # function set: 4-bit interface
        call    lcd_nibble

        li      a0, 0x28                # function set: 4-bit, 2 lines, 5x8 dots
        call    lcd_command
        li      a0, 0x0C                # display on, cursor off, blink off
        call    lcd_command
        li      a0, 0x06                # entry mode: increment, no shift
        call    lcd_command
        li      a0, 0x01                # clear display
        call    lcd_command

        li      a0, 0x40                # CGRAM address 0: custom character 0
        call    lcd_command
        la      s1, heart
        li      s2, 8                   # 8 pixel rows, bits 4..0
2:      lbu     a0, 0(s1)
        call    lcd_data
        addi    s1, s1, 1
        addi    s2, s2, -1
        bnez    s2, 2b

        li      a0, 0x80                # DDRAM address 0x00: line 1
        call    lcd_command
        la      a0, line1
        call    lcd_print
        li      a0, 0xC0                # DDRAM address 0x40: line 2
        call    lcd_command
        la      a0, line2
        call    lcd_print
        li      a0, 0xC0 + 15           # last column of line 2
        call    lcd_command
        li      a0, 0                   # custom character 0
        call    lcd_data

        li      s3, 0
loop:
        li      a0, 0xC0 + 7            # line 2, column 7
        call    lcd_command
        mv      a0, s3
        call    lcd_number
        li      a0, 100
        call    delay_ms
        addi    s3, s3, 1
        j       loop

# ------------------------------------------------------------
# lcd_command(a0) / lcd_data(a0): send an instruction / a
# character code, after waiting for the busy flag.
# ------------------------------------------------------------
lcd_command:
        li      a1, 0
        j       lcd_write
lcd_data:
        li      a1, 1
lcd_write:                              # a0 = byte, a1 = RS
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s4, 8(sp)
        sw      s5, 4(sp)
        mv      s4, a0
        mv      s5, a1
        call    lcd_wait
        li      t0, RS
        beqz    s5, 1f
        sw      t0, GPIO_OUT_W1TS(s0)   # RS = 1: character data
        j       2f
1:      sw      t0, GPIO_OUT_W1TC(s0)   # RS = 0: instruction
2:      srli    a0, s4, 4
        call    lcd_nibble              # high nibble
        andi    a0, s4, 15
        call    lcd_nibble              # low nibble
        lw      s5, 4(sp)
        lw      s4, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# lcd_nibble(a0 = 0..15): put it on D4..D7 and pulse E.
lcd_nibble:
        li      t0, DATA
        sw      t0, GPIO_OUT_W1TC(s0)
        slli    t0, a0, DATA_SHIFT
        sw      t0, GPIO_OUT_W1TS(s0)
        li      t1, E
        sw      t1, GPIO_OUT_W1TS(s0)   # E HIGH
        li      t2, 40                  # >= 450 ns
1:      addi    t2, t2, -1
        bnez    t2, 1b
        sw      t1, GPIO_OUT_W1TC(s0)   # E LOW: the LCD takes the nibble
        li      t2, 40
2:      addi    t2, t2, -1
        bnez    t2, 2b
        ret

# lcd_wait: read the busy flag until it is 0. D4..D7 become
# inputs while RW = 1, because the LCD drives them.
lcd_wait:
        li      t0, DATA
        sw      t0, GPIO_ENABLE_W1TC(s0)
        li      t0, RS
        sw      t0, GPIO_OUT_W1TC(s0)   # RS = 0: busy flag + address counter
        li      t0, RW
        sw      t0, GPIO_OUT_W1TS(s0)   # RW = 1: read
        li      t1, E
1:      sw      t1, GPIO_OUT_W1TS(s0)   # E HIGH: high nibble, D7 = busy flag
        li      t2, 40
2:      addi    t2, t2, -1
        bnez    t2, 2b
        lw      t3, GPIO_IN(s0)
        sw      t1, GPIO_OUT_W1TC(s0)
        li      t2, 40
3:      addi    t2, t2, -1
        bnez    t2, 3b
        sw      t1, GPIO_OUT_W1TS(s0)   # second pulse: low nibble (not needed)
        li      t2, 40
4:      addi    t2, t2, -1
        bnez    t2, 4b
        sw      t1, GPIO_OUT_W1TC(s0)
        li      t2, 40
5:      addi    t2, t2, -1
        bnez    t2, 5b
        andi    t3, t3, BUSY
        bnez    t3, 1b
        sw      t0, GPIO_OUT_W1TC(s0)   # RW = 0
        li      t0, DATA
        sw      t0, GPIO_ENABLE_W1TS(s0)  # D4..D7 outputs again
        ret

# lcd_print(a0 = address of a zero-terminated string)
lcd_print:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s1, 8(sp)
        mv      s1, a0
1:      lbu     a0, 0(s1)
        beqz    a0, 2f
        call    lcd_data
        addi    s1, s1, 1
        j       1b
2:      lw      s1, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# lcd_number(a0): print a0 as 5 decimal digits
lcd_number:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s1, 8(sp)
        sw      s2, 4(sp)
        mv      s1, a0
        li      s2, 10000
1:      divu    a0, s1, s2
        remu    s1, s1, s2
        addi    a0, a0, 48              # '0' + digit
        call    lcd_data
        li      t0, 10
        divu    s2, s2, t0
        bnez    s2, 1b
        lw      s2, 4(sp)
        lw      s1, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret
${DELAY_MS}`,
      components: [
        { id: 'lcd1', type: 'lcd1602', x: 260, y: 40, props: { color: 'blue', vcc: '5V' }, conn: { RS: 0, RW: 1, E: 2, D4: 4, D5: 5, D6: 6, D7: 7 } }
      ]
    },
    {
      id: 'lcd-i2c',
      name: 'LCD1602 over I2C (PCF8574)',
      description: 'Bit-bang I2C (SDA, SCL with ACK) to an LCD1602 with a PCF8574 backpack at address 0x27 and show a seconds counter.',
      code: `# ============================================================
#  LCD1602 with an I2C backpack (PCF8574 at address 0x27).
#  A byte written to the PCF8574 sets its 8 port pins:
#  P0 = RS, P1 = RW, P2 = E, P3 = backlight, P4..P7 = D4..D7.
#  One nibble reaches the LCD as two port writes, with E = 1
#  and then E = 0 (the LCD latches on the falling edge).
#  I2C is bit-banged open-drain on SDA = GPIO2, SCL = GPIO3:
#  GPIO_OUT stays 0, enabling the output pulls a line LOW and
#  disabling it lets the backpack's pull-up take it HIGH, so
#  the PCF8574 can pull SDA LOW to acknowledge each byte.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT_W1TC,     0x0C
        .equ GPIO_ENABLE_W1TS,  0x24     # pull LOW
        .equ GPIO_ENABLE_W1TC,  0x28     # release (HIGH)
        .equ GPIO_IN,           0x3C
        .equ IO_MUX_BASE,       0x60009000
        .equ FUN_WPU,           1 << 8   # weak pull-up
        .equ FUN_IE,            1 << 9   # input enable
        .equ SYSTIMER_BASE,     0x60023000
        .equ SDA_PIN,           2
        .equ SCL_PIN,           3
        .equ LCD_ADDR,          0x27
        .equ BL,                0x08     # P3: backlight on
        .equ EN,                0x04     # P2: E

        .data
line1:  .asciz "LCD1602 over I2C"
line2:  .asciz "Seconds:"
no_ack: .asciz "No ACK at I2C address 0x27: check SDA, SCL and power.\\n"

        .text
main:
        li      s0, GPIO_BASE
        li      s1, 1 << SCL_PIN
        li      s2, 1 << SDA_PIN
        or      t0, s1, s2
        sw      t0, GPIO_OUT_W1TC(s0)   # an enabled line is LOW

        li      t0, IO_MUX_BASE + 4 + 4 * SDA_PIN
        lw      t1, 0(t0)
        ori     t1, t1, FUN_IE | FUN_WPU    # read SDA for the ACK
        sw      t1, 0(t0)
        li      t0, IO_MUX_BASE + 4 + 4 * SCL_PIN
        lw      t1, 0(t0)
        ori     t1, t1, FUN_WPU
        sw      t1, 0(t0)

        li      a0, 50
        call    delay_ms                # > 15 ms after power-up (40 ms at 3.3 V)
        li      a0, BL                  # backlight on, E LOW
        call    pcf_write
        beqz    a0, 1f
        la      a0, no_ack
        li      a7, 4                   # ecall: print string
        ecall

        # 4-bit set-up: nibble 3 three times, then 2 (one E pulse each)
1:      li      a0, 0x30
        call    lcd_nibble
        li      a0, 5
        call    delay_ms                # > 4.1 ms
        li      a0, 0x30
        call    lcd_nibble
        li      a0, 1
        call    delay_ms                # > 100 us
        li      a0, 0x30
        call    lcd_nibble
        li      a0, 1
        call    delay_ms
        li      a0, 0x20                # function set: 4-bit interface
        call    lcd_nibble
        li      a0, 1
        call    delay_ms

        li      a0, 0x28                # 4-bit, 2 lines, 5x8 dots
        call    lcd_command
        li      a0, 0x0C                # display on, cursor off
        call    lcd_command
        li      a0, 0x06                # entry mode: increment
        call    lcd_command
        li      a0, 0x01                # clear display: takes 1.52 ms
        call    lcd_command
        li      a0, 2
        call    delay_ms

        li      a0, 0x80                # line 1
        call    lcd_command
        la      a0, line1
        call    lcd_print
        li      a0, 0xC0                # line 2
        call    lcd_command
        la      a0, line2
        call    lcd_print

        li      s3, 0                   # seconds
loop:
        li      a0, 0xC0 + 9            # line 2, column 9
        call    lcd_command
        mv      a0, s3
        call    lcd_number
        li      a0, 1000
        call    delay_ms
        addi    s3, s3, 1
        j       loop

# ------------------------------------------------------------
# lcd_command(a0) / lcd_data(a0): send a byte as two nibbles.
# Each I2C transfer takes far longer than the 37 us the LCD
# needs, so no busy-flag check is needed here.
# ------------------------------------------------------------
lcd_command:
        li      a1, 0
        j       lcd_write
lcd_data:
        li      a1, 1                   # P0 = RS
lcd_write:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s4, 8(sp)
        sw      s5, 4(sp)
        mv      s4, a0
        mv      s5, a1
        andi    a0, s4, 0xF0
        or      a0, a0, s5
        call    lcd_nibble              # high nibble
        slli    a0, s4, 4
        andi    a0, a0, 0xF0
        or      a0, a0, s5
        call    lcd_nibble              # low nibble
        lw      s5, 4(sp)
        lw      s4, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# lcd_nibble(a0 = nibble << 4 | RS): one I2C transfer with two
# port writes, E = 1 then E = 0.
lcd_nibble:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s6, 8(sp)
        ori     s6, a0, BL
        call    i2c_start
        li      a0, LCD_ADDR << 1       # address + write
        call    i2c_byte
        ori     a0, s6, EN
        call    i2c_byte                # E HIGH
        mv      a0, s6
        call    i2c_byte                # E LOW: the LCD takes the nibble
        call    i2c_stop
        lw      s6, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# pcf_write(a0 = port byte) -> a0 = 0 if the PCF8574 answered.
pcf_write:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s6, 8(sp)
        sw      s7, 4(sp)
        mv      s6, a0
        call    i2c_start
        li      a0, LCD_ADDR << 1
        call    i2c_byte
        mv      s7, a0                  # ACK of the address
        mv      a0, s6
        call    i2c_byte
        call    i2c_stop
        mv      a0, s7
        lw      s7, 4(sp)
        lw      s6, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# lcd_print(a0 = address of a zero-terminated string)
lcd_print:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s9, 8(sp)               # (s1, s2 hold the SCL / SDA masks)
        mv      s9, a0
1:      lbu     a0, 0(s9)
        beqz    a0, 2f
        call    lcd_data
        addi    s9, s9, 1
        j       1b
2:      lw      s9, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# lcd_number(a0): print a0 as 5 decimal digits
lcd_number:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s9, 8(sp)
        sw      s10, 4(sp)
        mv      s9, a0
        li      s10, 10000
1:      divu    a0, s9, s10
        remu    s9, s9, s10
        addi    a0, a0, 48              # '0' + digit
        call    lcd_data
        li      t0, 10
        divu    s10, s10, t0
        bnez    s10, 1b
        lw      s10, 4(sp)
        lw      s9, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# ------------------------------------------------------------
# I2C, about 100 kHz. SDA changes only while SCL is LOW, except
# for start (SDA falls while SCL is HIGH) and stop (SDA rises).
# ------------------------------------------------------------
i2c_start:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s2, GPIO_ENABLE_W1TS(s0)    # SDA LOW while SCL is HIGH
        call    i2c_delay
        sw      s1, GPIO_ENABLE_W1TS(s0)    # SCL LOW
        call    i2c_delay
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

i2c_stop:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s2, GPIO_ENABLE_W1TS(s0)    # SDA LOW
        call    i2c_delay
        sw      s1, GPIO_ENABLE_W1TC(s0)    # SCL HIGH
        call    i2c_delay
        sw      s2, GPIO_ENABLE_W1TC(s0)    # SDA HIGH while SCL is HIGH
        call    i2c_delay
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# i2c_byte(a0 = byte) -> a0 = 0 if acknowledged. MSB first.
i2c_byte:
        addi    sp, sp, -16
        sw      ra, 12(sp)
        sw      s7, 8(sp)
        sw      s8, 4(sp)
        mv      s7, a0
        li      s8, 8
1:      andi    t0, s7, 0x80
        beqz    t0, 2f
        sw      s2, GPIO_ENABLE_W1TC(s0)    # bit 1: release SDA
        j       3f
2:      sw      s2, GPIO_ENABLE_W1TS(s0)    # bit 0: SDA LOW
3:      call    i2c_delay
        sw      s1, GPIO_ENABLE_W1TC(s0)    # SCL HIGH: the slave reads SDA
        call    i2c_delay
        sw      s1, GPIO_ENABLE_W1TS(s0)    # SCL LOW
        slli    s7, s7, 1
        addi    s8, s8, -1
        bnez    s8, 1b

        sw      s2, GPIO_ENABLE_W1TC(s0)    # release SDA for the ACK
        call    i2c_delay
        sw      s1, GPIO_ENABLE_W1TC(s0)    # 9th clock
        call    i2c_delay
        lw      s7, GPIO_IN(s0)
        srli    s7, s7, SDA_PIN
        andi    s7, s7, 1               # ACK = 0
        sw      s1, GPIO_ENABLE_W1TS(s0)    # SCL LOW: the slave releases SDA
        call    i2c_delay
        mv      a0, s7
        lw      s8, 4(sp)
        lw      s7, 8(sp)
        lw      ra, 12(sp)
        addi    sp, sp, 16
        ret

# i2c_delay: about 5 us at 160 MHz (half a 100 kHz clock). Clobbers t6.
i2c_delay:
        li      t6, 400
1:      addi    t6, t6, -1
        bnez    t6, 1b
        ret
${DELAY_MS}`,
      components: [
        { id: 'lcd1', type: 'lcd1602i2c', x: 260, y: 60, props: { color: 'blue', addr: '27', vcc: '5V' }, conn: { SDA: 2, SCL: 3 } }
      ]
    },
    {
      id: 'lab-chaser',
      board: 'labc3',
      jumpers: { LED: true, '7S': false, PB: true },
      name: 'Lab board: LED chaser + 4 buttons',
      description: 'Running light on the lab board\'s 8 LEDs (GPIO0..7). PB1 reverses it, PB2 / PB3 make it faster / slower, PB4 pauses it.',
      code: `# ============================================================
#  Lab board: running light on LED1..LED8, controlled by PB1..PB4
#    LED1..LED8 = GPIO0..7 (lit when HIGH; jumper LED installed)
#    PB1..PB4   = GPIO9, 10, 20, 21 (LOW while pressed)
#    PB1: reverse   PB2: faster   PB3: slower   PB4: pause
#  In the simulator, click the buttons or press keys 1..4.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT,          0x04
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ GPIO_IN,           0x3C
        .equ SYSTIMER_BASE,     0x60023000
${MCU_SEL_EQU}${LAB_BUTTONS_EQU}        .equ LED_MASK,          0xFF

        .text
main:
        li      s0, GPIO_BASE
        li      t0, LED_MASK
        sw      t0, GPIO_ENABLE_W1TS(s0)    # GPIO0..7 = outputs
${GPIO_FUNC(4, 7)}${LAB_BUTTONS_SETUP}        li      s1, 0                       # position of the lit LED (0..7)
        li      s2, 1                       # direction: +1 or -1
        li      s3, 15                      # step time in 10 ms ticks
        li      s4, 0                       # 1 = paused

loop:
        li      t0, 1
        sll     t0, t0, s1                  # one LED on
        lw      t1, GPIO_OUT(s0)            # read-modify-write so that
        andi    t1, t1, ~LED_MASK           # other pins keep their state
        or      t1, t1, t0
        sw      t1, GPIO_OUT(s0)

        mv      s6, s3                      # wait s3 ticks of 10 ms,
wait:                                       # checking the buttons each tick
        li      a0, 10
        call    delay_ms
        call    new_presses
        li      t0, PB1
        and     t1, a0, t0
        beqz    t1, 1f
        neg     s2, s2                      # PB1: reverse
1:      li      t0, PB2
        and     t1, a0, t0
        beqz    t1, 2f
        li      t2, 5
        ble     s3, t2, 2f
        addi    s3, s3, -5                  # PB2: faster (down to 50 ms)
2:      li      t0, PB3
        and     t1, a0, t0
        beqz    t1, 3f
        li      t2, 100
        bge     s3, t2, 3f
        addi    s3, s3, 5                   # PB3: slower (up to 1 s)
3:      li      t0, PB4
        and     t1, a0, t0
        beqz    t1, 4f
        xori    s4, s4, 1                   # PB4: pause / resume
4:      addi    s6, s6, -1
        bnez    s6, wait

        bnez    s4, loop                    # paused: stay on this LED
        add     s1, s1, s2                  # next LED, wrapping 7 -> 0 and 0 -> 7
        andi    s1, s1, 7
        j       loop
${LAB_NEW_PRESSES}${DELAY_MS}`,
      components: []
    },
    {
      id: 'lab-7seg',
      board: 'labc3',
      jumpers: { LED: false, '7S': true, PB: true },
      name: 'Lab board: hex counter on the 7-segment display',
      description: 'Show 0..F on the lab board\'s 7-segment display (GPIO0..7). PB1 counts up, PB2 down, PB3 resets, PB4 toggles the decimal point.',
      code: `# ============================================================
#  Lab board: hexadecimal counter on the 7-segment display
#    segments a..g, dp = GPIO0..7 (common cathode: a HIGH pin
#    lights its segment; jumper 7S installed)
#    PB1: +1   PB2: -1   PB3: back to 0   PB4: decimal point
#  The value is also printed on the serial monitor.
#  In the simulator, click the buttons or press keys 1..4.
# ============================================================
        .equ GPIO_BASE,         0x60004000
        .equ GPIO_OUT,          0x04
        .equ GPIO_ENABLE_W1TS,  0x24
        .equ GPIO_IN,           0x3C
        .equ SYSTIMER_BASE,     0x60023000
${MCU_SEL_EQU}${LAB_BUTTONS_EQU}        .equ SEG_MASK,          0xFF

        .data
digits:                                     # bit0 = a ... bit6 = g
        .byte   0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07
        .byte   0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71
msg:    .asciz  "value = "

        .text
main:
        li      s0, GPIO_BASE
        li      t0, SEG_MASK
        sw      t0, GPIO_ENABLE_W1TS(s0)    # GPIO0..7 = outputs
${GPIO_FUNC(4, 7)}${LAB_BUTTONS_SETUP}        la      s1, digits
        li      s2, 0                       # value 0..15
        li      s3, 0                       # decimal point: 0 or 0x80
        call    show

loop:
        li      a0, 10                      # check the buttons every 10 ms
        call    delay_ms
        call    new_presses
        beqz    a0, loop
        mv      s4, a0
        li      t0, PB1
        and     t1, s4, t0
        beqz    t1, 1f
        addi    s2, s2, 1                   # PB1: up
1:      li      t0, PB2
        and     t1, s4, t0
        beqz    t1, 2f
        addi    s2, s2, -1                  # PB2: down
2:      li      t0, PB3
        and     t1, s4, t0
        beqz    t1, 3f
        li      s2, 0                       # PB3: reset
3:      li      t0, PB4
        and     t1, s4, t0
        beqz    t1, 4f
        xori    s3, s3, 0x80                # PB4: decimal point on / off
4:      andi    s2, s2, 15                  # wrap F -> 0 and 0 -> F
        call    show
        la      a0, msg
        li      a7, 4                       # ecall: print string
        ecall
        mv      a0, s2
        li      a7, 1                       # print int
        ecall
        li      a0, '\\n'
        li      a7, 11                      # print char
        ecall
        j       loop

# show: segment pattern of digit s2, plus the decimal point s3
show:
        add     t0, s1, s2
        lbu     t1, 0(t0)
        or      t1, t1, s3
        lw      t2, GPIO_OUT(s0)
        andi    t2, t2, ~SEG_MASK
        or      t2, t2, t1
        sw      t2, GPIO_OUT(s0)
        ret
${LAB_NEW_PRESSES}${DELAY_MS}`,
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
