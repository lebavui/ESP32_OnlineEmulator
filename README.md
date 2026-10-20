# RVSim C3: ESP32-C3 RISC-V assembly simulator

A Wokwi-style web simulator where you write **RISC-V assembly** and run it on a simulated
**ESP32-C3**, with **LEDs, push buttons, slide switches and 7-segment displays** wired to the board's GPIO pins.

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
  - Push button (pull-up or pull-down, optional keyboard key)
  - Slide switch (ON → 3V3 or ON → GND)
  - 7-segment display (common cathode or anode)
  - The board's own BOOT (GPIO9) and RST buttons

  LEDs and segments show PWM/multiplexing brightness. Each part draws its fixed GND or 3V3 terminal to match its wiring mode.
- **Boards:** ESP32-C3-DevKitM-1 or ESP32-C3 SuperMini (correct header pinout, the SuperMini's blue LED on GPIO8, BOOT and RST buttons), chosen above the breadboard and saved with the project.
- **Real hardware** (⚡ Hardware menu, Chrome / Edge on a desktop): build the program for a real ESP32-C3 and, over Web Serial, either load it into SRAM and run it or write it to flash; or download the firmware `.bin` for `esptool.py write_flash 0x0`. The board's serial output appears in the serial monitor, and what you type is sent to the board. The menu shows which port is in use (named after its USB chip, since browsers hide COM names from pages) and lets you switch to or forget another port. A small runtime added to the program turns off the watchdogs, sets `sp`/`gp`, implements the `ecall` services over USB-Serial-JTAG and UART0, and reports crashes (`mcause`, `mepc`, `mtval`). Tested on an ESP32-C3 SuperMini.
- **Wiring:** click a part's pin, then a GPIO pin on the board. You can also pick the GPIO in the part's settings panel.
- **Wire style** (toolbar menu, saved with the project): curved wires, or horizontal / vertical wires. Horizontal / vertical wiring works like Wokwi: click to place points, and a diagonal step bends at a right angle along the direction you first moved the mouse (Backspace removes the last point). Click a wire to edit it Tinkercad-style: drag corner handles, drag segment handles to move a segment (adding corners where needed), double-click a corner to remove it. Wires without points are routed automatically.
- **Auto power** (toolbar toggle, saved with the project): when ON, parts' GND / 3V3 pins are connected automatically. When OFF, each part shows its supply pin(s), which you wire to a GND or 3V3 pin on the board; an unpowered part does nothing, and the rail you wire to sets the part's mode (e.g. LED active-low, button pull-down, common-anode display).
- **Debugging:** Run, Pause, Step (F10), breakpoints, `ebreak`, and slow "trace" clock speeds. The bottom panels show registers, memory, GPIO state and the assembled listing: one row per machine word with its address, encoding and disassembled base instruction, so a pseudo-instruction like `li` or `la` shows the `lui` / `auipc` / `addi` it expands to.
- **Light / dark theme:** the ☀ / ☾ button in the top bar. It follows the system setting until you pick one.
- **Projects:**
  - 10 built-in examples, 3 of them for the SuperMini's on-board LED, BOOT button and USB serial port
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
| `js/components.js` | Part definitions (rendering and behaviour) |
| `js/examples.js` | Example projects |
| `js/app.js` | UI: editor, breadboard, simulation loop, panels |
| `tests/run-tests.js` | Assembler, CPU and example tests (`node tests/run-tests.js`) |

## Simplifications compared with real hardware

- IO_MUX models only `MCU_SEL`, `FUN_IE`, `FUN_WPU` and `FUN_WPD`; other fields such as `FUN_DRV` read back what was written. The GPIO matrix isn't modelled: a pin in a GPIO function is always a plain GPIO, and non-GPIO functions only stop GPIO output (U0TXD drives an idle high, the others drive nothing). A floating pin reads 0 instead of a random value.
- The USB Serial/JTAG PHY isn't modelled: GPIO18/19 work as GPIOs without disabling USB first, and the D+ pull-up on GPIO19 is always on.
- The CPU runs at 160 MHz. A program run on a real board through the Hardware menu runs at 20 MHz (XTAL/2, as the ROM leaves the clock; measured), so delays that count instructions are 8× slower there. SYSTIMER-based delays and the `sleep` / `time` services are correct on both.
- The standard counter CSRs (`cycle`, `time`, `instret`, `mcycle`, …) work in the simulator but don't exist on the ESP32-C3. The hardware runtime emulates them with the chip's own cycle counter (CSR 0x7E2, also modelled in the simulator); their high halves read 0 there.
- On the SuperMini, UART0 is on GPIO20/21, not on the USB-C port: use USB-Serial-JTAG or the `ecall` services to talk to the computer.
- Every instruction takes one cycle. There are no interrupts, caches or flash/ROM functions.
- The C (compressed) extension isn't generated or decoded.
- Misaligned loads and stores, and accesses to unmapped addresses, stop the simulation with an error.
