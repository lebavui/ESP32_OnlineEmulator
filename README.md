# RVSim C3: ESP32-C3 RISC-V assembly simulator

A Wokwi-style web simulator where you write **RISC-V assembly** and run it on a simulated
**ESP32-C3**, with **LEDs, RGB LEDs, push buttons, slide switches, 7-segment displays, TM1637 4-digit displays, LCD1602 character LCDs (4-bit parallel or I2C) and MAX7219 LED matrices** wired to the board's GPIO pins.

It's plain HTML/CSS/JavaScript with no build step or dependencies, and everything runs in the browser.

## Running

Open `index.html` in a modern browser (Chrome, Edge, Firefox or Safari). Double-clicking the file works.
To host it, serve the folder with any static web server, for example:

```sh
npx serve .          # or: python -m http.server
```

## Features

- **Editor:** syntax highlighting, line numbers, breakpoints (click a line number) and error markers.
- **Assembler:** a two-pass RV32IM + Zicsr assembler with the GNU-as style directives, the standard pseudo-instructions, expressions, `%hi/%lo`, and local labels (`1:` / `1b` / `1f`).
- **CPU:** an RV32IM interpreter at a nominal 160 MHz. The status bar shows the simulation speed relative to real time.
- **ESP32-C3 model:**
  - 384 KB SRAM, mapped twice (code at `0x40380000`, data at `0x3FCA0000`).
  - GPIO registers (`OUT`, `W1TS/W1TC`, `ENABLE`, `IN`).
  - IO_MUX function select, input enable and internal pull-up / pull-down (`MCU_SEL`, `FUN_IE`, `FUN_WPU`, `FUN_WPD`) with the reset values from the datasheet's pin table. Pins whose IO MUX function 0 isn't GPIO (GPIO4–7 JTAG, GPIO12–17 SPI flash, GPIO20/21 UART0) need `MCU_SEL` = 1 before `GPIO_OUT` reaches them, and writing `GPIO_OUT` for such a pin prints a warning. GPIO21 idles high as U0TXD, and GPIO19 has the USB D+ pull-up. Buttons leave their pin floating when released, and reading a floating pin, or one with `FUN_IE` = 0, prints a warning.
  - SYSTIMER (16 MHz) for accurate delays.
  - UART0 FIFO and USB-Serial-JTAG (send and receive), shown in the serial monitor.
  - Simulator errors, warnings (e.g. floating inputs, outputs not routed by IO_MUX) and exit notices go to a separate **Messages** panel, with the simulated time and a link to the source line.
  - `ecall` services for printing, sleeping, reading input and exiting (in the simulator, and on hardware through the runtime).
- **Parts:**
  - LED (colors, active-high or active-low)
  - RGB LED (common cathode or anode); the colour mixes the R, G and B pins by duty cycle, so software PWM gives any colour
  - Push button (pull-up or pull-down, optional keyboard key)
  - Slide switch (ON → 3V3 or ON → GND)
  - 7-segment display (common cathode or anode)
  - LED matrix: 8×8 module with a MAX7219 driver, or 4 modules daisy-chained (32×8), driven by bit-banging DIN / CS / CLK. All MAX7219 registers are modelled (digits, Code B decode, intensity, scan limit, shutdown, display test); the simulator follows every clock edge as the program writes the pins
  - 4-digit 7-segment display with a TM1637 driver (colon or decimal points), driven by bit-banging CLK / DIO. The chip's start / stop conditions, ACK (it pulls DIO low, so the program can read it), data / address / display control commands and brightness are modelled; the module's pull-ups on CLK and DIO are applied
  - LCD1602 16×2 character LCD (HD44780), either wired in 4-bit mode with 7 wires (RS, RW, E, D4–D7) or through a PCF8574 I2C backpack (SDA, SCL, address 0x27 / 0x3F). The controller's instructions, custom characters, display shift, cursor / blink, busy flag and data reads (the LCD drives D4–D7, or the PCF8574 answers an I2C read) and execution times are modelled: a byte sent while the controller is busy is lost, with a warning
  - The board's own BOOT (GPIO9) and RST buttons
  - On the lab board: 8 LEDs, a 7-segment digit and 4 push buttons, with jumpers that connect or disconnect them

  LEDs and segments show PWM/multiplexing brightness. Each part draws its fixed GND or 3V3 terminal to match its wiring mode.
- **Boards:** ESP32-C3-DevKitM-1, ESP32-C3 SuperMini, Seeed Studio XIAO ESP32C3 (correct header pinout, the XIAO's D0–D10 names in the pin tooltips, the SuperMini's blue LED on GPIO8, BOOT and RST buttons) or the ESP32-C3 Lab Board, chosen in the top bar and saved with the project. The lab board is a SuperMini on a carrier PCB with LED1–LED8 on GPIO0–7 (active high), a common-cathode 7-segment digit (a–g, dp on GPIO0–7) and push buttons PB1–PB4 on GPIO9, 10, 20, 21 (to GND; keys 1–4). Its jumpers LED, 7S and PB (click to install / remove, saved with the project) connect the LEDs, the display and the buttons' 10k pull-ups.
- **Real hardware** (⚡ Hardware menu, Chrome / Edge on a desktop): build the program for a real ESP32-C3 and, over Web Serial, either load it into SRAM and run it or write it to flash; or download the firmware `.bin` for `esptool.py write_flash 0x0`. The board's serial output appears in the serial monitor, and what you type is sent to the board. The menu shows which port is in use (named after its USB chip, since browsers hide COM names from pages) and lets you switch to or forget another port. A small runtime added to the program turns off the watchdogs, sets `sp`/`gp`, implements the `ecall` services over USB-Serial-JTAG and UART0, and reports crashes (`mcause`, `mepc`, `mtval`). Tested on an ESP32-C3 SuperMini.
- **Wiring:** click a part's pin, then a GPIO pin on the board. You can also pick the GPIO in the part's settings panel.
- **Part names** (Settings dialog, gear button in the top bar, saved with the project): show or hide the names under the parts (led1, seg1, lcd1, …).
- **Wire style** (Settings dialog, saved with the project): curved wires, or horizontal / vertical wires. Horizontal / vertical wiring works like Wokwi: click to place points, and a diagonal step bends at a right angle along the direction you first moved the mouse (Backspace removes the last point). Click a wire to edit it Tinkercad-style: drag corner handles, drag segment handles to move a segment (adding corners where needed), double-click a corner to remove it. Wires without points are routed automatically.
- **Power supply** (Settings dialog, saved with the project; the gear button shows an orange dot while it is Manual): when Automatic, parts' GND / 3V3 pins are connected automatically. When Manual, each part shows its supply pin(s), which you wire to a GND or 3V3 pin on the board; an unpowered part does nothing, and the rail you wire to sets the part's mode (e.g. LED active-low, button pull-down, common-anode display).
- **Debugging:** Run, Pause, Step (F10), breakpoints, `ebreak`, and slow "trace" clock speeds. The bottom panels show registers, memory, GPIO state and the assembled listing: one row per machine word with its address, encoding and disassembled base instruction, so a pseudo-instruction like `li` or `la` shows the `lui` / `auipc` / `addi` it expands to.
- **Layout:** drag the dividers to resize the editor, breadboard and bottom panels. The arrow buttons on the dividers (or <kbd>Ctrl</kbd>+<kbd>B</kbd> / <kbd>Ctrl</kbd>+<kbd>J</kbd>) hide or show the code editor and the bottom panels (serial monitor, messages, registers, …) to give the breadboard more room; a dot on the bottom divider's button means new serial output or a warning arrived while they were hidden. The layout is remembered in the browser.
- **Light / dark theme:** the ☀ / ☾ button in the top bar. It follows the system setting until you pick one.
- **Projects:**
  - 17 built-in examples: 3 for the SuperMini's on-board LED, BOOT button and USB serial port, 2 for the lab board (LED chaser, 7-segment hex counter)
  - Autosave in the browser
  - Save/open `.json` projects or `.S` source files
  - Share links that carry the whole project in the URL

## Files

| File | Purpose |
|---|---|
| `index.html`, `css/style.css` | Page layout, styles and the built-in reference docs |
| `js/assembler.js` | RISC-V assembler |
| `js/cpu.js` | RV32IM interpreter core |
| `js/esp32c3.js` | ESP32-C3 memory map and peripherals, run loop |
| `js/boards.js` | Board definitions: header pinout, on-board LED and buttons, artwork |
| `js/firmware.js` | Hardware build: Espressif firmware image + runtime (watchdogs, ecall services) |
| `js/flasher.js` | ESP32-C3 ROM bootloader protocol over Web Serial (run in RAM, write flash) |
| `js/max7219.js` | MAX7219 LED driver model (serial interface, registers, daisy chain) |
| `js/tm1637.js` | TM1637 LED driver model (two-wire interface with ACK, commands) |
| `js/lcd1602.js` | HD44780 LCD controller (4-bit interface, busy flag, font) and PCF8574 I2C backpack models |
| `js/components.js` | Part definitions (rendering and behaviour) |
| `js/examples.js` | Example projects |
| `js/app.js` | UI: editor, breadboard, simulation loop, panels |
| `tests/run-tests.js` | Assembler, CPU and example tests (`node tests/run-tests.js`) |

## Simplifications compared with real hardware

- IO_MUX models only `MCU_SEL`, `FUN_IE`, `FUN_WPU` and `FUN_WPD`; other fields such as `FUN_DRV` read back what was written. The GPIO matrix isn't modelled: a pin in a GPIO function is always a plain GPIO, and non-GPIO functions only stop GPIO output (U0TXD drives an idle high, the others drive nothing). A floating pin reads 0 instead of a random value.
- The USB Serial/JTAG PHY isn't modelled: GPIO18/19 work as GPIOs without disabling USB first, and the D+ pull-up on GPIO19 is always on.
- The CPU runs at 160 MHz. A program run on a real board through the Hardware menu runs at 20 MHz (XTAL/2, as the ROM leaves the clock; measured), so delays that count instructions are 8× slower there. SYSTIMER-based delays and the `sleep` / `time` services are correct on both.
- The standard counter CSRs (`cycle`, `time`, `instret`, `mcycle`, …) work in the simulator but don't exist on the ESP32-C3. The hardware runtime emulates them with the chip's own cycle counter (CSR 0x7E2, also modelled in the simulator); their high halves read 0 there.
- On the SuperMini and the XIAO ESP32C3, UART0 is on GPIO20/21, not on the USB-C port: use USB-Serial-JTAG or the `ecall` services to talk to the computer.
- The MAX7219 accepts any clock speed and timing (the real chip needs ≥ 50 ns CLK pulses, up to 10 MHz), and DOUT is not available as a pin. The matrix shows each row as written; it doesn't model the multiplexing flicker or the brightness change with the scan limit. Power-supply limits (the MAX7219 is specified for 4–5.5 V; 3V3 is allowed) aren't checked.
- The TM1637 accepts any clock speed (the real chip needs a few microseconds per CLK half-period) and doesn't scan keys: a key read returns 0xFF. It starts with the display off and blank registers. Its pull-ups go to the module's VCC; with VCC on 5V a real ESP32-C3 pin would see 5V, the simulator doesn't check that.
- LCD1602: E pulse widths and setup times aren't checked, only the controller's execution times. The power-up busy time counts from the program start. The 5×10 font, contrast (V0) and the Japanese half of the character ROM aren't modelled, and the I2C backpack accepts any clock speed (the PCF8574 allows up to 100 kHz).
- Lab board: the LEDs and the display share GPIO0–7, but they don't load the pins (an LED doesn't pull an input pin low), and the display's single common resistor doesn't make digits with many lit segments dimmer.
- Every instruction takes one cycle. There are no interrupts, caches or flash/ROM functions.
- The C (compressed) extension isn't generated or decoded.
- Misaligned loads and stores, and accesses to unmapped addresses, stop the simulation with an error.
