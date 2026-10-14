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
  - SYSTIMER (16 MHz) for accurate delays.
  - UART0 FIFO and USB-Serial-JTAG output, shown in the serial monitor.
  - Simulator-only `ecall` services for printing, sleeping and exiting.
- **Parts:**
  - LED (colors, active-high or active-low)
  - Push button (pull-up or pull-down, optional keyboard key)
  - Slide switch
  - 7-segment display (common cathode or anode)
  - The board's own BOOT (GPIO9) and RST buttons

  LEDs and segments show PWM/multiplexing brightness.
- **Wiring:** click a part's pin, then a GPIO pin on the board. You can also pick the GPIO in the part's settings panel.
- **Debugging:** Run, Pause, Step (F10), breakpoints, `ebreak`, and slow "trace" clock speeds. The bottom panels show registers, memory, GPIO state and the assembled listing with machine code.
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

- Inputs can always be read through `GPIO_IN_REG`. IO_MUX writes are accepted but not modelled, so you don't need `FUN_IE` (though the examples set it so the code also works on real hardware).
- Every instruction takes one cycle. There are no interrupts, caches or flash/ROM functions.
- The C (compressed) extension isn't generated or decoded.
- Misaligned loads and stores, and accesses to unmapped addresses, stop the simulation with an error.
