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
  - IO_MUX input enable and internal pull-up / pull-down (`FUN_IE`, `FUN_WPU`, `FUN_WPD`) with the chip's reset values. Buttons leave their pin floating when released, and reading a floating pin, or one with `FUN_IE` = 0, prints a warning.
  - SYSTIMER (16 MHz) for accurate delays.
  - UART0 FIFO and USB-Serial-JTAG output, shown in the serial monitor.
  - Simulator-only `ecall` services for printing, sleeping and exiting.
- **Parts:**
  - LED (colors, active-high or active-low)
  - Push button (pull-up or pull-down, optional keyboard key)
  - Slide switch (ON → 3V3 or ON → GND)
  - 7-segment display (common cathode or anode)
  - The board's own BOOT (GPIO9) and RST buttons

  LEDs and segments show PWM/multiplexing brightness. Each part draws its fixed GND or 3V3 terminal to match its wiring mode.
- **Wiring:** click a part's pin, then a GPIO pin on the board. You can also pick the GPIO in the part's settings panel.
- **Wire style** (toolbar menu, saved with the project): curved wires, or horizontal / vertical wires. Horizontal / vertical wiring works like Wokwi: click to place points, and a diagonal step bends at a right angle along the direction you first moved the mouse (Backspace removes the last point). Click a wire to edit it Tinkercad-style: drag corner handles, drag segment handles to move a segment (adding corners where needed), double-click a corner to remove it. Wires without points are routed automatically.
- **Auto power** (toolbar toggle, saved with the project): when ON, parts' GND / 3V3 pins are connected automatically. When OFF, each part shows its supply pin(s), which you wire to a GND or 3V3 pin on the board; an unpowered part does nothing, and the rail you wire to sets the part's mode (e.g. LED active-low, button pull-down, common-anode display).
- **Debugging:** Run, Pause, Step (F10), breakpoints, `ebreak`, and slow "trace" clock speeds. The bottom panels show registers, memory, GPIO state and the assembled listing with machine code.
- **Light / dark theme:** the ☀ / ☾ button in the top bar. It follows the system setting until you pick one.
- **Projects:**
  - 7 built-in examples
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
| `js/components.js` | Part definitions (rendering and behaviour) |
| `js/examples.js` | Example projects |
| `js/app.js` | UI: editor, breadboard, simulation loop, panels |
| `tests/run-tests.js` | Assembler, CPU and example tests (`node tests/run-tests.js`) |

## Simplifications compared with real hardware

- IO_MUX models only `FUN_IE`, `FUN_WPU` and `FUN_WPD`. Other fields such as `MCU_SEL` and `FUN_DRV` read back what was written, and every pin always works as a GPIO (the GPIO matrix isn't modelled). A floating pin reads 0 instead of a random value.
- Every instruction takes one cycle. There are no interrupts, caches or flash/ROM functions.
- The C (compressed) extension isn't generated or decoded.
- Misaligned loads and stores, and accesses to unmapped addresses, stop the simulation with an error.
