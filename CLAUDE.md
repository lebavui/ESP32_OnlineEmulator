# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RVSim C3: a browser-based, Wokwi-style simulator that assembles and runs RISC-V (RV32IM + Zicsr) assembly on a modelled ESP32-C3, with LEDs, buttons, slide switches, 7-segment displays and MAX7219 LED matrices wired to GPIO pins. Plain HTML/CSS/JS: no build step, no dependencies, no package.json.

## Commands

- Run the app: open `index.html` directly in a browser, or serve the folder (`npx serve .` / `python -m http.server`).
- Run tests: `node tests/run-tests.js` (exits non-zero on failure; prints `N passed, M failed` and a speed benchmark).
- There is no test framework or single-test filter: tests are top-level blocks using `check(name, cond, info)` in one file. To focus on one, temporarily comment out other blocks or run a snippet with `node -e` that `require`s the modules the same way the test file does.
- No linter or formatter is configured.
- Hardware check with a real ESP32-C3 on USB (needs pyserial): `python tools/hw-bridge.py COM11` in one terminal, then `node tools/hw-run.js ram|flash <example-id or file.S> [seconds] [text to send]`. It drives `js/firmware.js` + `js/flasher.js` exactly as the web app does and prints the board's output. `flash` overwrites the board's flash at 0x0.

## Architecture

Script load order in `index.html` matters: `assembler.js` → `cpu.js` → `esp32c3.js` → `firmware.js` → `flasher.js` → `boards.js` → `max7219.js` → `components.js` → `examples.js` → `app.js`. Each file except `app.js` is an IIFE that exports via `module.exports` under Node and otherwise attaches to `window` (`RVAsm`, `RV32Core`/`SimError`, `ESP32C3`, `Firmware`, `Flasher`, `BOARDS`/`DEFAULT_BOARD`, `MAX7219Chain`/`MAX7219Chip`, `PARTS`, `EXAMPLES`/`BLANK`). Keep this dual export pattern so the Node tests can `require` the same files the browser loads. `app.js` is browser-only and reads everything from `window`.

Layering (lower layers never depend on the UI):

1. **`assembler.js`**: `RVAsm.assemble(src)` → `{ ok, errors[{line,…}], text, data, … }`. Two-pass; text at `0x40380000` (IRAM view), data at `0x3FCA0000` (DRAM view). Test encodings are checked against GNU `as` reference values. `RVAsm.disassemble(word, addr, labels)` decodes one word to its base (non-pseudo) form for the Listing panel; a test round-trips every example instruction through it.
2. **`cpu.js`**: `RV32Core` interpreter. It talks only to a *bus* object (`fetch`, `read8/16/32`, `write8/16/32`, `onEcall`, `onEbreak`). One cycle per instruction; no C extension, interrupts or caches.
3. **`esp32c3.js`**: `ESP32C3` is the bus: one 384 KB SRAM mapped at both IRAM and DRAM bases, plus peripherals (UART0, GPIO, IO_MUX, SYSTIMER @16 MHz, USB-Serial-JTAG) and simulator `ecall` services (`a7` selects: print int/string/char/hex, time, sleep, read_char, exit). Key API used by both UI and tests:
   - `load(asmResult)`, `run(targetCycle, breakpoints, deadline, skipFirstBreakpoint)` returns a stop reason (`'budget'`, `'time'`, `'halt'`, `'ebreak'`, `'breakpoint'`, `'error'`), `stepOnce()`.
   - `setExternal({ force, value, pullUp, pullDown })`: bit masks describing what parts do to the pins (a number forces all pins, handy in tests).
   - `levels()` resolves pin level with priority: chip output driver (`drivenPins()`: `GPIO_ENABLE` only on pins whose IO_MUX `MCU_SEL` selects a GPIO function, plus U0TXD idle-high) → external force → pull-ups (external, IO_MUX `FUN_WPU`, USB D+ on GPIO19). `IOMUX_RESET` / `IOMUX_FUNCS` come from Tables 2-1 and 2-3 of the ESP32-C3 Series Datasheet (v1.7). `floatingPins()`, and reads of floating / `FUN_IE`=0 pins (`floatReads`, `ieOffReads`) and `GPIO_OUT` writes to non-GPIO-function outputs (`noFnWrites`) are recorded so the UI can warn.
   - `sampleDuty()` returns per-pin high-time fraction since the last call; this drives LED/segment brightness for PWM and multiplexing.
   - `onPinsChanged(levels)`: optional callback run at the instruction that changes any pin level; parts that decode a bit-banged serial stream hook in here so no clock edge is missed.
   - Output bytes accumulate in `machine.tx`.
4. **Real hardware** (no simulator involvement):
   - **`firmware.js`**: `buildFirmware(asmResult)` → `{ image, segments, entry }`. The program keeps its simulator addresses; a runtime (assembly in `RUNTIME_SRC`, assembled with `RVAsm.assemble(src, { textBase })` right after the program's text, 256-aligned for `mtvec`) disables the RTC/super/TIMG watchdogs, sets `sp` = `HW_STACK_TOP` and `gp`, and handles traps: `ecall` services over USB-Serial-JTAG + UART0, other exceptions print `mcause/mepc/mtval`. `makeImage` writes Espressif's app-image format (header, extended header with chip id 5, segments, XOR checksum, appended SHA-256) that the ROM boots from flash offset 0x0.
   - **`flasher.js`**: `ESPLoader` speaks the ROM bootloader protocol (SLIP, SYNC, READ_REG chip check, MEM_* to run from RAM, FLASH_* to write; no stub, no FLASH_END) over a transport `{ write, setSignals, onData, usbJtag }`; `WebSerialTransport` adapts Web Serial. The USB-Serial-JTAG reset sequence must pass through DTR=1/RTS=1 (as esptool does), and writes need a timeout because a running program doesn't read the USB port. `startMonitor` switches incoming bytes to the program's output before the chip starts.
   - Hardware behaviour was verified on an ESP32-C3 SuperMini; IO_MUX reset values in `esp32c3.js` were read back from that chip after a flash boot.
5. **`boards.js`**: `BOARDS` (DevKitM-1, SuperMini, XIAO ESP32C3): header pin lists top to bottom, wireable GPIOs, board pull-ups, button/LED positions and SVG artwork. `app.js` `setBoard()` rebuilds the board layer, `POWER_PINS` (keyed by side+index, e.g. `R1`) and `GPIO_PINS`; `changeBoard()` re-attaches supply wires to the nearest pin of the same rail and drops GPIO wires the new board lacks.
6. **`components.js`**: `PARTS` registry. Each part definition is data + functions (`w/h`, `pins`, `props`, `render`, `update`, `power`, `powerAny`, `rail`, `setRail`, …); the header comment of the file documents the full contract. Adding a part means adding an entry here and handling its input behaviour in `app.js` (`applyInputs`) if it drives pins. Parts with a chip model (the `matrix` part, backed by `MAX7219Chain` from `max7219.js`) get it from `app.js` `syncDevices()`, which rebuilds `machine.onPinsChanged` whenever parts or wiring change; `resetDevices()` runs on program load, stop, board change and project load (a power cycle). `supplies` lets a part's supply pins use 5V (default GND / 3V3 only) and `size(c)` gives a settings-dependent size.
7. **`examples.js`**: built-in projects (code + parts + wiring, optional `board`). Every example must assemble and build for hardware; several have behaviour tests in `tests/run-tests.js`.
8. **`app.js`**: all UI in one IIFE: editor (textarea + highlighted overlay), breadboard SVG stage and wiring, inspector, panels (registers, memory, GPIO, listing, serial). The simulation loop is `frame()` via `requestAnimationFrame`: it advances a cycle target by real elapsed time × selected clock rate and calls `machine.run` with a ~13 ms wall-clock budget. Part inputs are pushed to the machine by `applyInputs()`; outputs are pulled via `sampleDuty()` in the render update.

### Wiring / power model

- A component instance is `{ id, type, x, y, props, conn, route }`; `conn` maps part pin name → GPIO number or a power pin key; `route` holds manual wire points.
- **Auto power** ON: supply pins are implicit. OFF: parts expose GND/3V3 pins that must be wired by hand; an unpowered part does nothing, and the rail it is wired to rewrites its mode via `setRail` (e.g. LED active-low, button pull-down, common-anode).
- Buttons/switches only connect a pin to GND or 3V3; a released button leaves the pin floating, so programs must enable pull-ups/downs in IO_MUX. The DevKit pull-up on GPIO9 (BOOT) is always applied.

### Persistence

`serializeProject()` / `loadProject()` define the project JSON (`app: 'rvsim-c3', version: 1`, board, code, autoPower, wireStyle, components, breakpoints). It is used for localStorage autosave (`rvsim-c3-project-v1*` keys), `.json` save/open, and share links (`#p=...` in the URL hash). Keep new project-level settings in this schema and tolerant of old projects that lack them.

## Conventions

- The in-app reference docs (Reference tab) live in `index.html`; the feature list and the "simplifications vs. real hardware" list live in `README.md`. Update both when changing user-visible behaviour or the hardware model.
- Hardware constants (addresses, IO_MUX reset values) follow the ESP32-C3 TRM; cite the source in a comment when adding new ones.
- Theme colours are CSS custom properties in `css/style.css`: dark is the `:root` default, light overrides live under `:root[data-theme="light"]`.
