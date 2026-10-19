# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RVSim C3: a browser-based, Wokwi-style simulator that assembles and runs RISC-V (RV32IM + Zicsr) assembly on a modelled ESP32-C3, with LEDs, buttons, slide switches and 7-segment displays wired to GPIO pins. Plain HTML/CSS/JS: no build step, no dependencies, no package.json.

## Commands

- Run the app: open `index.html` directly in a browser, or serve the folder (`npx serve .` / `python -m http.server`).
- Run tests: `node tests/run-tests.js` (exits non-zero on failure; prints `N passed, M failed` and a speed benchmark).
- There is no test framework or single-test filter: tests are top-level blocks using `check(name, cond, info)` in one file. To focus on one, temporarily comment out other blocks or run a snippet with `node -e` that `require`s the modules the same way the test file does.
- No linter or formatter is configured.

## Architecture

Script load order in `index.html` matters: `assembler.js` → `cpu.js` → `esp32c3.js` → `components.js` → `examples.js` → `app.js`. Each file except `app.js` is an IIFE that exports via `module.exports` under Node and otherwise attaches to `window` (`RVAsm`, `RV32Core`/`SimError`, `ESP32C3`, `PARTS`, `EXAMPLES`/`BLANK`). Keep this dual export pattern so the Node tests can `require` the same files the browser loads. `app.js` is browser-only and reads everything from `window`.

Layering (lower layers never depend on the UI):

1. **`assembler.js`**: `RVAsm.assemble(src)` → `{ ok, errors[{line,…}], text, data, … }`. Two-pass; text at `0x40380000` (IRAM view), data at `0x3FCA0000` (DRAM view). Test encodings are checked against GNU `as` reference values.
2. **`cpu.js`**: `RV32Core` interpreter. It talks only to a *bus* object (`fetch`, `read8/16/32`, `write8/16/32`, `onEcall`, `onEbreak`). One cycle per instruction; no C extension, interrupts or caches.
3. **`esp32c3.js`**: `ESP32C3` is the bus: one 384 KB SRAM mapped at both IRAM and DRAM bases, plus peripherals (UART0, GPIO, IO_MUX, SYSTIMER @16 MHz, USB-Serial-JTAG) and simulator `ecall` services (`a7` selects: print int/string/char/hex, time, sleep, read_char, exit). Key API used by both UI and tests:
   - `load(asmResult)`, `run(targetCycle, breakpoints, deadline, skipFirstBreakpoint)` returns a stop reason (`'budget'`, `'time'`, `'halt'`, `'ebreak'`, `'breakpoint'`, `'error'`), `stepOnce()`.
   - `setExternal({ force, value, pullUp, pullDown })`: bit masks describing what parts do to the pins (a number forces all pins, handy in tests).
   - `levels()` resolves pin level with priority: chip output driver (`drivenPins()`: `GPIO_ENABLE` only on pins whose IO_MUX `MCU_SEL` selects a GPIO function, plus U0TXD idle-high) → external force → pull-ups (external, IO_MUX `FUN_WPU`, USB D+ on GPIO19). `IOMUX_RESET` / `IOMUX_FUNCS` come from Tables 2-1 and 2-3 of the ESP32-C3 Series Datasheet (v1.7). `floatingPins()`, and reads of floating / `FUN_IE`=0 pins (`floatReads`, `ieOffReads`) and `GPIO_OUT` writes to non-GPIO-function outputs (`noFnWrites`) are recorded so the UI can warn.
   - `sampleDuty()` returns per-pin high-time fraction since the last call; this drives LED/segment brightness for PWM and multiplexing.
   - Output bytes accumulate in `machine.tx`.
4. **`components.js`**: `PARTS` registry. Each part definition is data + functions (`w/h`, `pins`, `props`, `render`, `update`, `power`, `powerAny`, `rail`, `setRail`, …); the header comment of the file documents the full contract. Adding a part means adding an entry here and handling its input behaviour in `app.js` (`applyInputs`) if it drives pins.
5. **`examples.js`**: built-in projects (code + parts + wiring). Every example must assemble; several have behaviour tests in `tests/run-tests.js`.
6. **`app.js`**: all UI in one IIFE: editor (textarea + highlighted overlay), breadboard SVG stage and wiring, inspector, panels (registers, memory, GPIO, listing, serial). The simulation loop is `frame()` via `requestAnimationFrame`: it advances a cycle target by real elapsed time × selected clock rate and calls `machine.run` with a ~13 ms wall-clock budget. Part inputs are pushed to the machine by `applyInputs()`; outputs are pulled via `sampleDuty()` in the render update.

### Wiring / power model

- A component instance is `{ id, type, x, y, props, conn, route }`; `conn` maps part pin name → GPIO number or a power pin key; `route` holds manual wire points.
- **Auto power** ON: supply pins are implicit. OFF: parts expose GND/3V3 pins that must be wired by hand; an unpowered part does nothing, and the rail it is wired to rewrites its mode via `setRail` (e.g. LED active-low, button pull-down, common-anode).
- Buttons/switches only connect a pin to GND or 3V3; a released button leaves the pin floating, so programs must enable pull-ups/downs in IO_MUX. The DevKit pull-up on GPIO9 (BOOT) is always applied.

### Persistence

`serializeProject()` / `loadProject()` define the project JSON (`app: 'rvsim-c3', version: 1`, code, autoPower, wireStyle, components, breakpoints). It is used for localStorage autosave (`rvsim-c3-project-v1*` keys), `.json` save/open, and share links (`#p=...` in the URL hash). Keep new project-level settings in this schema and tolerant of old projects that lack them.

## Conventions

- The in-app reference docs (Reference tab) live in `index.html`; the feature list and the "simplifications vs. real hardware" list live in `README.md`. Update both when changing user-visible behaviour or the hardware model.
- Hardware constants (addresses, IO_MUX reset values) follow the ESP32-C3 TRM; cite the source in a comment when adding new ones.
- Theme colours are CSS custom properties in `css/style.css`: dark is the `:root` default, light overrides live under `:root[data-theme="light"]`.
