/* RVSim C3 - user interface glue: editor, breadboard stage, simulation loop, panels. */
(function () {
  'use strict';

  const { RVAsm, ESP32C3, PARTS, EXAMPLES, BLANK } = window;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hex8 = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  const CPU_HZ = ESP32C3.CPU_HZ;

  const GPIO_PINS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18, 19, 20, 21];
  const GPIO_NOTES = {
    2: 'strapping', 4: 'JTAG MTMS', 5: 'JTAG MTDI', 6: 'JTAG MTCK', 7: 'JTAG MTDO', 8: 'strapping', 9: 'BOOT button',
    18: 'USB D-', 19: 'USB D+ (pull-up)', 20: 'UART0 RX', 21: 'UART0 TX'
  };
  const WIRE_COLORS = ['#2ecc71', '#3498db', '#e67e22', '#b07cff', '#f1c40f', '#1abc9c', '#ff5d73', '#ff8fd1', '#00c2e0', '#9ccc65', '#ffa94d'];
  const STORE_KEY = 'rvsim-c3-project-v1';

  // ================================================================ state

  const machine = new ESP32C3();
  let comps = [];
  let breakpointLines = new Set();
  let program = null;          // last successfully assembled program
  let loadedSource = null;     // source text currently loaded in the machine
  let simState = 'stopped';    // stopped | running | paused | halted
  let activeBps = new Set();
  let selection = null;        // {kind:'comp', id} | {kind:'wire', id, pin}
  let pending = null;          // wire being drawn: {kind:'comp', id, pin} | {kind:'board', gpio} | {kind:'board', key}
  let autoPower = true;        // parts' GND / 3V3 pins are connected automatically
  let wireStyle = 'curve';     // 'curve' | 'ortho' (horizontal / vertical segments with user-placed corners)
  let bootPressed = false;

  // ================================================================ helpers

  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
  }

  function gpioLabel(g) {
    return `GPIO${g}` + (GPIO_NOTES[g] ? ` (${GPIO_NOTES[g]})` : '');
  }

  // ================================================================ editor

  const ta = $('#code');
  const hl = $('#codeHl');
  const gutter = $('#gutter');
  let lineEls = [], gutterEls = [];
  let errorLines = new Map();
  let currentLine = 0;
  let renderQueued = false;
  const REG_SET = new Set(Object.keys(RVAsm.REGS));

  function commentStart(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"') { q = c; continue; }
      if (c === "'" && /^'(\\.|[^\\'])'/.test(s.slice(i))) { q = c; continue; }
      if (c === '#' || c === ';' || (c === '/' && s[i + 1] === '/')) return i;
    }
    return -1;
  }

  const span = (cls, s) => `<span class="t-${cls}">${esc(s)}</span>`;

  function highlightLine(line) {
    const ci = commentStart(line);
    const code = ci < 0 ? line : line.slice(0, ci);
    let out = '', seenOp = false, m;
    const re = /("(?:\\.|[^"\\])*"?)|('(?:\\.|[^'\\])'?)|(0[xX][0-9a-fA-F_]+|0[bB][01_]+(?!\w)|\d+[fb]?(?!\w))|(%(?:hi|lo)\b)|([A-Za-z_.$][\w.$]*)(\s*:)?|(\s+)|([\s\S])/g;
    while ((m = re.exec(code))) {
      if (m[1] || m[2]) out += span('str', m[0]);
      else if (m[3]) {
        if (!seenOp && /^\d+$/.test(m[3]) && code.slice(re.lastIndex).trimStart().startsWith(':')) out += span('label', m[3]);
        else out += span('num', m[3]);
      } else if (m[4]) out += span('fn', m[4]);
      else if (m[5]) {
        const w = m[5], lw = w.toLowerCase();
        if (m[6] && !seenOp) out += span('label', w) + esc(m[6]);
        else if (!seenOp) {
          seenOp = true;
          out += span(w[0] === '.' ? 'dir' : RVAsm.MNEMONICS.has(lw) ? 'op' : 'opx', w);
          if (m[6]) out += esc(m[6]);
        } else {
          out += span(REG_SET.has(lw) ? 'reg' : 'sym', w) + (m[6] ? esc(m[6]) : '');
        }
      } else out += esc(m[0]);
    }
    if (ci >= 0) out += span('cmt', line.slice(ci));
    return out;
  }

  function renderEditor() {
    renderQueued = false;
    const lines = ta.value.split('\n');
    let html = '<div class="hl-inner">';
    let gh = '';
    for (let i = 0; i < lines.length; i++) {
      html += `<div class="ln">${highlightLine(lines[i]) || ' '}</div>`;
      gh += `<div class="gl" data-line="${i + 1}">${i + 1}</div>`;
    }
    html += '<div class="ln-pad"></div></div>';
    hl.innerHTML = html;
    gutter.innerHTML = gh + '<div class="ln-pad"></div>';
    lineEls = hl.firstChild.children;
    gutterEls = gutter.children;
    decorateLines();
    syncScroll();
    updateModified();
  }

  function queueRender() {
    if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderEditor); }
  }

  function decorateLines() {
    const n = gutterEls.length - 1;
    for (let i = 0; i < n; i++) {
      const line = i + 1;
      const cur = line === currentLine;
      const err = errorLines.has(line);
      lineEls[i].className = 'ln' + (cur ? ' cur' : '') + (err ? ' err' : '');
      const g = gutterEls[i];
      let cls = 'gl';
      if (breakpointLines.has(line)) cls += program && bpAddrForLine(line) === undefined ? ' bp bp-off' : ' bp';
      if (cur) cls += ' cur';
      if (err) cls += ' err';
      g.className = cls;
      g.title = err ? errorLines.get(line) : 'Click to toggle breakpoint';
    }
  }

  function syncScroll() {
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  }

  function setCurrentLine(line, reveal) {
    currentLine = line || 0;
    decorateLines();
    if (reveal && currentLine) revealLine(currentLine);
  }

  function revealLine(line) {
    const top = (line - 1) * 20, h = ta.clientHeight;
    if (top < ta.scrollTop + 20 || top > ta.scrollTop + h - 60) ta.scrollTop = Math.max(0, top - h / 3);
    syncScroll();
  }

  function gotoLine(line) {
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
    revealLine(line);
  }

  function insertText(text) {
    ta.focus();
    if (!document.execCommand('insertText', false, text)) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.setRangeText(text, s, e, 'end');
      onCodeInput();
    }
  }

  function onCodeInput() {
    queueRender();
    scheduleSave();
  }

  function updateModified() {
    const mod = loadedSource !== null && ta.value !== loadedSource && simState !== 'stopped';
    $('#modFlag').textContent = mod ? '● modified — restart to apply' : '';
  }

  ta.addEventListener('input', onCodeInput);
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const s = ta.selectionStart, v = ta.value;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      if (e.shiftKey) {
        const m = /^( {1,4}|\t)/.exec(v.slice(lineStart));
        if (m) { ta.setSelectionRange(lineStart, lineStart + m[0].length); insertText(''); }
        return;
      }
      const col = s - lineStart;
      insertText(' '.repeat(8 - (col % 8)));
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const s = ta.selectionStart, v = ta.value;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart, s))[0];
      insertText('\n' + indent);
    }
  });

  gutter.addEventListener('click', e => {
    const g = e.target.closest('.gl');
    if (!g) return;
    const line = +g.dataset.line;
    if (breakpointLines.has(line)) breakpointLines.delete(line);
    else breakpointLines.add(line);
    refreshBreakpoints();
    decorateLines();
    scheduleSave();
  });
  gutter.addEventListener('wheel', e => { ta.scrollTop += e.deltaY; syncScroll(); }, { passive: true });

  function bpAddrForLine(line) {
    if (!program) return undefined;
    for (let l = line; l < line + 40; l++) {
      const a = program.lineToAddr.get(l);
      if (a !== undefined) return program.addrToLine.has(a) ? a : undefined;
    }
    return undefined;
  }

  function refreshBreakpoints() {
    activeBps = new Set();
    if (!program) return;
    for (const line of breakpointLines) {
      const a = bpAddrForLine(line);
      if (a !== undefined) activeBps.add(a);
    }
  }

  // ================================================================ assembling

  function assembleNow(quiet) {
    const res = RVAsm.assemble(ta.value);
    errorLines = new Map();
    for (const e of res.errors) if (!errorLines.has(e.line)) errorLines.set(e.line, e.message);
    renderProblems(res);
    if (res.ok) {
      program = res;
      refreshBreakpoints();
      renderListing();
    } else if (!quiet) {
      toast(`${res.errors.length} assembly error${res.errors.length > 1 ? 's' : ''}`, 'error');
    }
    decorateLines();
    return res.ok ? res : null;
  }

  function renderProblems(res) {
    const el = $('#problems');
    if (res.ok) {
      const syms = Object.keys(res.symbols).length;
      el.innerHTML = `<div class="ok">✓ Assembled: ${res.text.bytes.length} bytes code, ${res.data.bytes.length} bytes data, ${syms} labels · entry ${hex8(res.entry)}</div>`;
      return;
    }
    el.innerHTML = res.errors.map(e =>
      `<div class="perr" data-line="${e.line}"><span class="pl">line ${e.line}</span>${esc(e.message)}</div>`).join('');
  }

  $('#problems').addEventListener('click', e => {
    const p = e.target.closest('.perr');
    if (p) gotoLine(+p.dataset.line);
  });

  // ================================================================ simulation control

  let simTarget = 0, lastTs = 0, skipBp = false;
  let speedWindow = { sim: 0, real: 0, pct: 0 };
  let lastPanelUpdate = 0;

  function rate() { return +$('#speedSel').value; }

  function loadProgram() {
    const res = assembleNow();
    if (!res) return false;
    try {
      machine.load(res);
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
    loadedSource = ta.value;
    ioWarned = 0;
    outWarned = 0;
    applyInputs();
    clearSerial();
    clearMessages();
    prevRegs = null;
    return true;
  }

  function run() {
    if (simState === 'running') return;
    const modified = loadedSource !== ta.value;
    if (simState === 'stopped' || simState === 'halted' || modified) {
      if (!loadProgram()) return;
      if (modified && simState === 'paused') toast('Code changed — program restarted');
      skipBp = false;
    } else {
      skipBp = true;
    }
    simState = 'running';
    lastTs = performance.now();
    simTarget = machine.core.cycle;
    speedWindow = { sim: 0, real: 0, pct: speedWindow.pct };
    setCurrentLine(0);
    updateControls();
    requestAnimationFrame(frame);
  }

  function pause(reason) {
    if (simState !== 'running') return;
    simState = 'paused';
    showPc(true);
    updateControls();
    updateAll(true);
    if (reason) toast(reason);
  }

  function stop() {
    simState = 'stopped';
    machine.reset();
    applyInputs();
    setCurrentLine(0);
    updateControls();
    updateAll(true);
  }

  function step() {
    if (simState === 'running') { pause(); return; }
    if (simState === 'stopped' || simState === 'halted' || loadedSource !== ta.value) {
      if (!loadProgram()) return;
      simState = 'paused';
      showPc(true);
      updateControls();
      updateAll(true);
      return;
    }
    const r = machine.stepOnce();
    handleStop(r);
    if (simState === 'paused') showPc(true);
    updateAll(true);
  }

  function showPc(reveal) {
    const line = program && program.addrToLine.get(machine.core.pc);
    setCurrentLine(line || 0, reveal);
  }

  function handleStop(r) {
    if (r === 'halt') {
      simState = 'halted';
      addMessage('info', machine.haltMessage);
      setCurrentLine(0);
    } else if (r === 'error') {
      simState = 'halted';
      const line = program && program.addrToLine.get(machine.error.pc);
      addMessage('error', machine.error.message, line);
      $('[data-tab="messages"]').click();               // the run stopped: show why
      toast(machine.error.message, 'error');
      setCurrentLine(line || 0, true);
    } else if (r === 'breakpoint') {
      simState = 'paused';
      showPc(true);
      toast('Breakpoint hit');
    } else if (r === 'ebreak') {
      simState = 'paused';
      showPc(true);
      toast('ebreak — paused');
    }
    updateControls();
  }

  function frame(ts) {
    if (simState !== 'running') return;
    let dt = ts - lastTs;
    lastTs = ts;
    if (dt > 100) dt = 100;
    if (dt < 0) dt = 0;
    const hz = rate();
    simTarget += dt / 1000 * hz;
    const before = machine.core.cycle;
    const t0 = performance.now();
    const r = machine.run(simTarget, activeBps, t0 + 13, skipBp);
    skipBp = false;
    if (r === 'time' || machine.core.cycle < simTarget - hz * 0.02) simTarget = Math.max(machine.core.cycle, simTarget - hz * 0.02);

    speedWindow.sim += machine.core.cycle - before;
    speedWindow.real += dt;
    if (speedWindow.real >= 500) {
      speedWindow.pct = (speedWindow.sim / CPU_HZ) / (speedWindow.real / 1000) * 100;
      speedWindow.sim = 0;
      speedWindow.real = 0;
    }

    if (r !== 'budget' && r !== 'time') handleStop(r);
    if (simState === 'running' && hz <= 1000) showPc(true);
    updateAll(simState !== 'running');
    if (simState === 'running') requestAnimationFrame(frame);
  }

  // Part settings are locked while a program is loaded (running, paused or halted).
  const simActive = () => simState !== 'stopped';
  const SETTINGS_LOCKED = 'Stop the simulation to change part settings';

  function updateControls() {
    const running = simState === 'running';
    $('#btnRun').disabled = running;
    $('#btnPause').disabled = !running;
    $('#btnStop').disabled = simState === 'stopped';
    $('#btnRun').innerHTML = simState === 'paused' ? '▶ Resume' : '▶ Run';
    document.body.dataset.sim = simState;
    if (simActive() && selection) select(null); // no part settings while simulating
    updateModified();
  }

  function updateStatus() {
    const t = machine.timeSeconds;
    const time = t < 10 ? t.toFixed(3) : t.toFixed(2);
    let txt;
    switch (simState) {
      case 'running': {
        const hz = rate();
        const sp = hz >= CPU_HZ ? `${Math.min(999, speedWindow.pct).toFixed(0)}%` : `${$('#speedSel').selectedOptions[0].textContent}`;
        txt = `<b class="st-run">● Running</b> <span>${sp}</span>`;
        break;
      }
      case 'paused': txt = `<b class="st-pause">❚❚ Paused</b> <span>pc ${hex8(machine.core.pc)}${currentLine ? ' · line ' + currentLine : ''}</span>`; break;
      case 'halted': txt = machine.error ? '<b class="st-err">✖ Error</b>' : '<b class="st-stop">■ Exited</b>'; break;
      default: txt = '<b class="st-stop">○ Stopped</b>';
    }
    $('#status').innerHTML = `${txt}<span class="mono">t = ${time} s</span><span class="mono dim">${fmtCount(machine.core.instret)} instr</span>`;
  }

  function fmtCount(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' G';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' k';
    return String(n);
  }

  function updateAll(force) {
    checkInputWarnings();
    updateStage();
    flushSerial();
    updateStatus();
    const now = performance.now();
    if (force || now - lastPanelUpdate > 120) {
      lastPanelUpdate = now;
      updatePanels(force);
    }
  }

  $('#btnRun').addEventListener('click', run);
  $('#btnPause').addEventListener('click', () => pause());
  $('#btnStep').addEventListener('click', step);
  $('#btnStop').addEventListener('click', stop);
  $('#btnAssemble').addEventListener('click', () => { if (assembleNow()) toast('Assembled successfully', 'ok'); });
  $('#speedSel').addEventListener('change', () => {
    simTarget = machine.core.cycle;
    try { localStorage.setItem(STORE_KEY + '-speed', $('#speedSel').value); } catch (_) { /* ignore */ }
  });

  // ================================================================ inputs (buttons / switches)

  // Buttons and switches only connect a pin to GND or 3V3. A released button leaves its pin
  // floating, so the program needs a pull-up / pull-down (FUN_WPU / FUN_WPD in IO_MUX).
  function applyInputs() {
    let force = 0, value = 0;
    const set = (g, v) => { if (!((force >>> g) & 1)) { force |= 1 << g; if (v) value |= 1 << g; } };
    if (bootPressed) set(9, 0);
    for (const c of comps) {
      const g = c.conn['1'];
      if (g === undefined || g === null) continue;
      if (c.type === 'button') {
        if (c.pressed && isPowered(c)) set(g, c.props.mode === 'pulldown' ? 1 : 0);
      } else if (c.type === 'switch') {
        const v = PARTS.switch.level(c, autoPower);
        if (v !== null) set(g, v);
      }
    }
    machine.setExternal({ force, value, pullUp: 1 << 9 });   // the DevKit has a pull-up on GPIO9 (BOOT)
    if (simState !== 'running') updateAll(true);
  }

  // Warn (once per run and pin) when the program reads a button / switch pin that is
  // floating or has its input buffer turned off: it works by luck on real hardware, or not at all.
  let ioWarned = 0;
  function inputPartPins() {
    let mask = 0;
    for (const c of comps) {
      const g = c.conn['1'];
      if ((c.type === 'button' || c.type === 'switch') && g !== undefined && g !== null) mask |= 1 << g;
    }
    return mask;
  }
  function checkInputWarnings() {
    checkOutputWarnings();
    const pins = inputPartPins();
    const ieOff = machine.ieOffReads & pins & ~ioWarned;
    const floating = machine.floatReads & pins & ~ioWarned & ~ieOff;
    if (!ieOff && !floating) return;
    const list = m => GPIO_PINS.filter(g => (m >>> g) & 1);
    for (const g of list(ieOff)) {
      addMessage('warn', `GPIO${g} was read with FUN_IE = 0 (input disabled), so it always reads 0. Set bit 9 of IO_MUX_GPIO${g}_REG (0x${(0x60009004 + 4 * g).toString(16).toUpperCase()}).`);
    }
    for (const g of list(floating)) {
      addMessage('warn', `GPIO${g} was read while floating (nothing connected to GND / 3V3 and no pull resistor): real hardware reads random values. Enable FUN_WPU (bit 8, pull-up) or FUN_WPD (bit 7, pull-down) in IO_MUX_GPIO${g}_REG.`);
    }
    toast(`GPIO${list(ieOff | floating).join(', GPIO')}: input not set up correctly, see Messages`, 'error');
    ioWarned |= ieOff | floating;
  }

  // Warn (once per run and pin) when the program writes GPIO_OUT for an output pin whose
  // IO MUX function is not GPIO: the write never reaches the pin.
  let outWarned = 0;
  function checkOutputWarnings() {
    const pins = machine.noFnWrites & ~outWarned;
    if (!pins) return;
    const list = GPIO_PINS.filter(g => (pins >>> g) & 1);
    for (const g of list) {
      addMessage('warn', `GPIO${g} is an output, but its IO MUX function is ${machine.pinFunction(g) || 'reserved'}, so GPIO_OUT does not reach the pin. Set MCU_SEL (bits 14:12) of IO_MUX_GPIO${g}_REG (0x${(0x60009004 + 4 * g).toString(16).toUpperCase()}) to 1 (function GPIO${g}).`);
    }
    toast(`GPIO${list.join(', GPIO')}: output not routed to the pin, see Messages`, 'error');
    outWarned |= pins;
  }

  function pressButton(c, down) {
    if (!!c.pressed === down) return;
    c.pressed = down;
    applyInputs();
    const el = compEls.get(c.id);
    if (el) PARTS.button.update(el, c);
  }

  // ================================================================ stage (board + parts + wires)

  const svg = $('#stage');
  svg.innerHTML = `
    <defs>
      <filter id="glowBlur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7"/></filter>
      <filter id="segGlow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <radialGradient id="lensShine" cx="35%" cy="28%" r="65%">
        <stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset=".45" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="shield" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#e3e6eb"/><stop offset="1" stop-color="#a3aab5"/>
      </linearGradient>
      <pattern id="gridPat" width="20" height="20" patternUnits="userSpaceOnUse">
        <circle cx="10" cy="10" r="1" class="grid-dot"/>
      </pattern>
    </defs>
    <rect id="gridBg" x="-5000" y="-5000" width="10000" height="10000" fill="url(#gridPat)"/>
    <g id="world">
      <g id="boardLayer"></g>
      <g id="compLayer"></g>
      <g id="wireLayer"></g>
      <path id="pendingWire" d="" />
    </g>`;
  const world = $('#world'), boardLayer = $('#boardLayer'), compLayer = $('#compLayer'), wireLayer = $('#wireLayer');
  const pendingWire = $('#pendingWire');
  const view = { x: 40, y: 30, k: 1 };
  let compEls = new Map();

  // ---- ESP32-C3-DevKitM-1 board
  const BOARD = { w: 180, h: 476, y0: 78, pitch: 24, lx: 14, rx: 166 };
  const LEFT_PINS = ['GND', '3V3', '3V3', '2', '3', 'GND', 'RST', 'GND', '0', '1', '10', 'GND', '5V', '5V', 'GND'];
  const RIGHT_PINS = ['GND', '21', '20', 'GND', '9', '8', 'GND', '7', '6', '5', '4', 'GND', '18', '19', 'GND'];
  const boardPinPos = new Map();        // GPIO number or power pin key -> {x, y, side}
  // Power pins, keyed by side + index ('L0', 'R3', ...) because GND appears many times.
  const POWER_PINS = {};
  [['L', LEFT_PINS], ['R', RIGHT_PINS]].forEach(([side, list]) => list.forEach((l, i) => {
    if (/^(GND|3V3|5V)$/.test(l)) POWER_PINS[side + i] = l;
  }));
  const POWER_COLORS = { GND: '#6b7280', '3V3': '#ff453a' };

  const hasConn = (c, pin) => c.conn[pin] !== undefined && c.conn[pin] !== null;
  const powerPins = def => def.power || [];
  const findPin = (def, name) => def.pins.find(p => p.name === name) || powerPins(def).find(p => p.name === name);
  const isPowerPin = (def, name) => powerPins(def).some(p => p.name === name);
  const pinLabelOf = (def, c, p) => def.pinLabel ? def.pinLabel(c, p) : p.label;
  const targetName = t => typeof t === 'number' ? 'GPIO' + t : POWER_PINS[t];

  // A part works when auto power is on, or when its supply pin(s) are wired.
  function isPowered(c) {
    const pp = powerPins(PARTS[c.type]);
    if (autoPower || !pp.length) return true;
    return PARTS[c.type].powerAny ? pp.some(p => hasConn(c, p.name)) : pp.every(p => hasConn(c, p.name));
  }

  // Wire a supply pin to a board power pin; the rail sets the part's wiring mode.
  // Returns the supply pins that had to be disconnected because they now sit on the wrong rail.
  function attachPower(c, pin, key) {
    c.conn[pin] = key;
    PARTS[c.type].setRail(c, pin, POWER_PINS[key]);
    return dropMismatchedPower(c);
  }

  function dropMismatchedPower(c) {
    const def = PARTS[c.type], dropped = [];
    for (const p of powerPins(def)) {
      if (hasConn(c, p.name) && POWER_PINS[c.conn[p.name]] !== def.rail(c, p.name)) {
        delete c.conn[p.name];
        if (c.route) delete c.route[p.name];
        dropped.push(p.name);
      }
    }
    return dropped;
  }

  // Board pin with the given label that is closest to a part's pin.
  function nearestPowerPin(c, pin, label) {
    const p = findPin(PARTS[c.type], pin), x = c.x + p.x, y = c.y + p.y;
    let best = null, bestD = Infinity;
    for (const [key, l] of Object.entries(POWER_PINS)) {
      if (l !== label) continue;
      const bp = boardPinPos.get(key), d = Math.hypot(bp.x - x, bp.y - y);
      if (d < bestD) { bestD = d; best = key; }
    }
    return best;
  }

  function boardSvg() {
    let pins = '';
    const pin = (label, x, y, side, key) => {
      const isGpio = /^\d+$/.test(label);
      const isPower = !!POWER_PINS[key];
      if (isGpio) boardPinPos.set(+label, { x, y, side });
      if (isPower) boardPinPos.set(key, { x, y, side });
      const tip = isGpio ? gpioLabel(+label) : label === 'RST' ? 'RST (chip enable)'
        : label === 'GND' ? 'GND (ground)' : label + ' (supply)';
      const tx = side === 'L' ? x + 13 : x - 13;
      const text = isGpio ? 'IO' + label : label;
      return `<g class="bpin${isGpio ? ' gpio' : ' power'}${isPower ? ' rail' : ''}" data-pin="${isPower ? key : label}" transform="translate(${x} ${y})">
          <rect x="-8" y="-8" width="16" height="16" rx="2" class="pin-pad"/>
          <circle r="4.2" class="pin-hole"/><circle r="9" class="pin-hit"/>
          <title>${esc(tip)}</title>
        </g>
        <text x="${tx}" y="${y + 3}" class="pin-label${isGpio ? '' : ' pwr'}" text-anchor="${side === 'L' ? 'start' : 'end'}">${text}</text>`;
    };
    LEFT_PINS.forEach((l, i) => { pins += pin(l, BOARD.lx, BOARD.y0 + i * BOARD.pitch, 'L', 'L' + i); });
    RIGHT_PINS.forEach((l, i) => { pins += pin(l, BOARD.rx, BOARD.y0 + i * BOARD.pitch, 'R', 'R' + i); });
    const antenna = 'M60 22 h56 v6 h-50 v6 h50 v6 h-56';
    return `
      <g class="board">
        <rect x="68" y="452" width="44" height="30" rx="3" fill="#b8bec8" stroke="#7d8591"/>
        <rect x="74" y="458" width="32" height="8" rx="2" fill="#5d6470"/>
        <rect width="${BOARD.w}" height="${BOARD.h}" rx="10" fill="#18202e" stroke="#0a0d13" stroke-width="2"/>
        <circle cx="12" cy="12" r="5" fill="#0a0d13"/><circle cx="168" cy="12" r="5" fill="#0a0d13"/>
        <circle cx="12" cy="${BOARD.h - 12}" r="5" fill="#0a0d13"/><circle cx="168" cy="${BOARD.h - 12}" r="5" fill="#0a0d13"/>
        <rect x="50" y="10" width="80" height="150" rx="3" fill="#1d2a22"/>
        <path d="${antenna}" fill="none" stroke="#c9a74a" stroke-width="2"/>
        <rect x="54" y="48" width="72" height="108" rx="3" fill="url(#shield)" stroke="#7e8590"/>
        <text x="90" y="86" class="chip-text" text-anchor="middle">ESP32-C3</text>
        <text x="90" y="100" class="chip-sub" text-anchor="middle">MINI-1</text>
        <text x="90" y="128" class="chip-sub" text-anchor="middle">RISC-V · 160 MHz</text>
        <text x="90" y="140" class="chip-sub" text-anchor="middle">400 KB SRAM</text>
        <rect x="${BOARD.lx - 9}" y="${BOARD.y0 - 12}" width="18" height="${BOARD.pitch * 14 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="${BOARD.rx - 9}" y="${BOARD.y0 - 12}" width="18" height="${BOARD.pitch * 14 + 24}" rx="2" fill="#0b0d11"/>
        <rect x="70" y="182" width="40" height="40" rx="2" fill="#11151c" stroke="#2a3342"/>
        <text x="90" y="205" class="chip-sub light" text-anchor="middle">CP2102</text>
        <circle id="pwrLed" cx="76" cy="246" r="3.5" fill="#ff3b30"/>
        <text x="84" y="249" class="tiny light">PWR</text>
        <text x="90" y="300" class="board-title" text-anchor="middle">ESP32-C3</text>
        <text x="90" y="314" class="tiny light" text-anchor="middle">DevKitM-1</text>
        <g class="board-btn" data-board-btn="boot" transform="translate(58 420)">
          <rect x="-14" y="-10" width="28" height="20" rx="2" fill="#c9ccd2"/>
          <circle class="bb-cap" r="6.5" fill="#2b2f36"/>
          <text y="22" class="tiny light" text-anchor="middle">BOOT</text>
          <title>BOOT button (GPIO9, active low)</title>
        </g>
        <g class="board-btn" data-board-btn="rst" transform="translate(122 420)">
          <rect x="-14" y="-10" width="28" height="20" rx="2" fill="#c9ccd2"/>
          <circle class="bb-cap" r="6.5" fill="#2b2f36"/>
          <text y="22" class="tiny light" text-anchor="middle">RST</text>
          <title>RESET: restart the program</title>
        </g>
        ${pins}
      </g>`;
  }

  function compById(id) { return comps.find(c => c.id === id); }

  function renderComponents() {
    compLayer.innerHTML = comps.map(c => {
      const def = PARTS[c.type];
      const sel = selection && selection.kind === 'comp' && selection.id === c.id;
      const pins = def.pins.concat(autoPower ? [] : powerPins(def)).map(p => {
        const g = c.conn[p.name];
        const conn = g !== undefined && g !== null;
        const pwr = isPowerPin(def, p.name);
        const label = pinLabelOf(def, c, p) + (pwr ? ' → ' + def.rail(c, p.name) : '');
        const hint = pwr ? ' — click, then click a GND or 3V3 pin on the board' : ' — click, then click a GPIO pin on the board';
        // With powerAny, one wired supply pin is enough, so don't nag about the other one.
        const ok = conn || (pwr && def.powerAny && isPowered(c));
        return `<g class="cpin${ok ? ' connected' : ''}${pwr ? ' pwr' : ''}" data-comp="${c.id}" data-pin="${p.name}" transform="translate(${p.x} ${p.y})">
            <circle r="8" class="pin-hit"/><circle r="3.4" class="dot"/>
            <title>${esc(c.id)} · ${esc(label)}${conn ? ' → ' + targetName(g) : hint}</title>
          </g>`;
      }).join('');
      return `<g class="comp${sel ? ' selected' : ''}" data-id="${c.id}" transform="translate(${c.x} ${c.y})">
          <rect class="sel-box" x="-8" y="-14" width="${def.w + 16}" height="${def.h + 22}" rx="6"/>
          <g class="body">${def.render(c, { auto: autoPower })}</g>
          ${pins}
          <text class="comp-label" x="${def.w / 2}" y="${def.h + 20}" text-anchor="middle">${esc(c.id)}</text>
        </g>`;
    }).join('');
    compEls = new Map();
    for (const el of compLayer.children) compEls.set(el.dataset.id, el);
  }

  function wireColor(g) {
    return typeof g === 'number' ? WIRE_COLORS[GPIO_PINS.indexOf(g) % WIRE_COLORS.length] : POWER_COLORS[POWER_PINS[g]];
  }

  function wirePath(ax, ay, dir, bp) {
    const dy = dir === 'up' ? -1 : 1;
    const reach = Math.min(90, 26 + Math.abs(ay - bp.y) * 0.25);
    const out = Math.max(40, Math.min(160, Math.abs(bp.x - ax) * 0.35));
    const c2x = bp.x + (bp.side === 'L' ? -out : out);
    return `M${ax} ${ay} C${ax} ${ay + dy * reach} ${c2x} ${bp.y} ${bp.x} ${bp.y}`;
  }

  // ---- horizontal / vertical wires
  const snap5 = v => Math.round(v / 5) * 5;

  // Points through pts using only horizontal and vertical segments: a corner is inserted
  // between points that aren't in line. prevH = the segment leading into pts[0] was horizontal.
  function orthoPoints(pts, prevH) {
    let cur = { x: pts[0].x, y: pts[0].y };
    const out = [cur];
    for (let i = 1; i < pts.length; i++) {
      const p = { x: pts[i].x, y: pts[i].y };
      if (p.x === cur.x && p.y === cur.y) continue;
      if (p.x !== cur.x && p.y !== cur.y) {
        // keep going the way the previous segment went, then turn
        out.push(prevH ? { x: p.x, y: cur.y } : { x: cur.x, y: p.y });
        prevH = !prevH;
      } else prevH = p.y === cur.y;
      out.push(p);
      cur = p;
    }
    return out;
  }
  const polyD = pts => 'M' + pts.map(p => `${p.x} ${p.y}`).join(' L');
  const orthoD = (pts, prevH) => polyD(orthoPoints(pts, prevH));

  // Every point of a wire, from a part pin (exits vertically) through the user's corners
  // to a board pin; all segments are horizontal or vertical.
  function orthoWirePoints(ax, ay, dir, bp, route, g) {
    const a = { x: ax, y: ay };
    if (route && route.length) return orthoPoints([a, ...route, bp], false);
    const dy = dir === 'up' ? -1 : 1;
    // Board pin ahead of the part pin: straight out to its row, then across.
    if ((bp.y - ay) * dy >= 16) return orthoPoints([a, bp], false);
    // Otherwise leave the pin, run beside the board (lanes keep neighbouring wires apart), then go in.
    const lane = typeof g === 'number' ? (GPIO_PINS.indexOf(g) % 4) * 5 : 0;
    const sy = ay + dy * 16, mx = bp.x + (bp.side === 'L' ? -1 : 1) * (20 + lane);
    return orthoPoints([a, { x: ax, y: sy }, { x: mx, y: sy }, { x: mx, y: bp.y }, bp], false);
  }

  // Drop repeated points and points in the middle of a straight run.
  function simplifyPoints(pts) {
    const out = [];
    for (const p of pts) {
      const n = out.length;
      if (n && out[n - 1].x === p.x && out[n - 1].y === p.y) continue;
      if (n >= 2) {
        const a = out[n - 2], b = out[n - 1];
        if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop();
      }
      out.push(p);
    }
    return out;
  }

  // ---- editing the corners of a selected wire (Tinkercad-style handles)
  // A wire's full point list; null if it isn't drawn.
  function wirePointsOf(c, pin) {
    const def = PARTS[c.type], p = findPin(def, pin), g = c.conn[pin];
    const bp = g === undefined || g === null ? null : boardPinPos.get(g);
    if (!p || !bp) return null;
    return orthoWirePoints(c.x + p.x, c.y + p.y, p.dir, bp, c.route && c.route[pin], g);
  }

  function setWirePoints(c, pin, pts) {
    if (!c.route) c.route = {};
    c.route[pin] = pts.slice(1, -1);
  }

  // Corner i moves to `to`; neighbouring corners slide with it so their segments stay
  // horizontal / vertical. Pins never move: next to a pin, a small jog keeps its segment straight.
  function moveCorner(P, i, to) {
    const n = P.length, old = P[i];
    const out = P.map(q => ({ x: q.x, y: q.y }));
    out[i] = { x: to.x, y: to.y };
    for (const j of [i - 1, i + 1]) {
      if (j <= 0 || j >= n - 1) continue;
      if (P[j].y === old.y && P[j].x !== old.x) out[j].y = to.y;
      else if (P[j].x === old.x && P[j].y !== old.y) out[j].x = to.x;
    }
    // points from the pin towards corner c
    const jog = (pin, c) => {
      if (pin.x === old.x && c.x !== pin.x) { const my = snap5((pin.y + c.y) / 2); return [{ x: pin.x, y: my }, { x: c.x, y: my }]; }
      if (pin.y === old.y && c.y !== pin.y) { const mx = snap5((pin.x + c.x) / 2); return [{ x: mx, y: pin.y }, { x: mx, y: c.y }]; }
      return [];
    };
    const head = i === 1 ? jog(out[0], out[1]) : [];
    const tail = i === n - 2 ? jog(out[n - 1], out[n - 2]).reverse() : [];
    return [out[0], ...head, ...out.slice(1, n - 1), ...tail, out[n - 1]];
  }

  // Segment i (P[i] -> P[i+1]) moves sideways by delta. An end that is a pin, or whose other
  // segment runs the same way, keeps a new corner at its old place so the wire stays connected.
  function moveSegment(P, i, delta) {
    const n = P.length, horiz = P[i].y === P[i + 1].y;
    const parallel = (a, b) => horiz ? P[a].y === P[b].y : P[a].x === P[b].x;
    const shift = q => horiz ? { x: q.x, y: q.y + delta } : { x: q.x + delta, y: q.y };
    const out = [];
    for (let k = 0; k < n; k++) {
      const q = { x: P[k].x, y: P[k].y };
      if (k === i) {
        if (k === 0 || parallel(k - 1, k)) out.push(q);
        out.push(shift(q));
      } else if (k === i + 1) {
        out.push(shift(q));
        if (k === n - 1 || parallel(k, k + 1)) out.push(q);
      } else out.push(q);
    }
    return out;
  }

  function wireHandles(c, pin, P) {
    let html = '';
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], horiz = a.y === b.y;
      if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < 16) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      html += `<rect class="whandle seg" data-seg="${i}" x="${mx - (horiz ? 6 : 2.5)}" y="${my - (horiz ? 2.5 : 6)}" width="${horiz ? 12 : 5}" height="${horiz ? 5 : 12}" rx="2">
          <title>Drag to move this segment${i === 0 || i === P.length - 2 ? ' (adds corners)' : ''}</title></rect>`;
    }
    for (let i = 1; i < P.length - 1; i++) {
      html += `<circle class="whandle corner" data-pt="${i}" cx="${P[i].x}" cy="${P[i].y}" r="4.5">
          <title>Drag to move this corner · double-click to remove it</title></circle>`;
    }
    return `<g class="whandles" data-comp="${c.id}" data-pin="${pin}">${html}</g>`;
  }

  // Wiring with horizontal / vertical wires works like Wokwi: each click drops a point where
  // the mouse is, and if that is diagonal to the previous point an L-shaped bend is added.
  // The bend goes along the axis the mouse first moved on after leaving the previous point
  // (pending.orient); moving back close to that point lets the user pick again.
  const ORIENT_RADIUS = 10;
  const lastPoint = () => pending.pts.length ? pending.pts[pending.pts.length - 1] : pinWorldPos(pending);
  const snapPt = w => ({ x: snap5(w.x), y: snap5(w.y) });

  // Points leading from `from` to `to` (inclusive) using horizontal / vertical segments.
  function legTo(from, to, orient) {
    if (to.x === from.x || to.y === from.y) return [to];
    return [orient === 'v' ? { x: from.x, y: to.y } : { x: to.x, y: from.y }, to];
  }

  function trackOrient(w) {
    const last = lastPoint(), dx = w.x - last.x, dy = w.y - last.y;
    if (Math.hypot(dx, dy) < ORIENT_RADIUS) pending.orient = null;
    else if (!pending.orient) pending.orient = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
  }

  function addCornerAt(w) {
    const last = lastPoint();
    const pts = legTo(last, snapPt(w), pending.orient || 'h').filter(p => p.x !== last.x || p.y !== last.y);
    if (!pts.length) return;
    pending.pts.push(...pts);
    pending.groups.push(pts.length);   // so Backspace removes one click at a time
    pending.orient = null;
  }

  let lastMouse = null;
  function drawPending() {
    if (!pending || !lastMouse) return;
    const a = pinWorldPos(pending), w = lastMouse;
    pendingWire.setAttribute('d', wireStyle === 'ortho'
      ? orthoD([a, ...pending.pts, ...legTo(lastPoint(), snapPt(w), pending.orient || 'h')], pending.kind === 'board')
      : `M${a.x} ${a.y} L${w.x} ${w.y}`);
  }

  function clearRoute(c, pin) { if (c.route) delete c.route[pin]; }

  function renderWires() {
    let html = '', handles = '';
    for (const c of comps) {
      const def = PARTS[c.type];
      for (const p of def.pins.concat(autoPower ? [] : powerPins(def))) {
        const g = c.conn[p.name];
        if (g === undefined || g === null) continue;
        const bp = boardPinPos.get(g);
        if (!bp) continue;
        const pts = wireStyle === 'ortho' ? orthoWirePoints(c.x + p.x, c.y + p.y, p.dir, bp, c.route && c.route[p.name], g) : null;
        const d = pts ? polyD(pts) : wirePath(c.x + p.x, c.y + p.y, p.dir, bp);
        const sel = selection && selection.kind === 'wire' && selection.id === c.id && selection.pin === p.name;
        if (sel && pts) handles = wireHandles(c, p.name, pts);
        html += `<g class="wire${sel ? ' selected' : ''}" data-comp="${c.id}" data-pin="${p.name}">
            <path d="${d}" class="wire-outline"/>
            <path d="${d}" class="wire-core" stroke="${wireColor(g)}"/>
            <path d="${d}" class="wire-hit"/>
            <title>${esc(c.id)}.${esc(p.name)} → ${targetName(g)} (click to select, Delete to remove)</title>
          </g>`;
      }
    }
    wireLayer.innerHTML = html + handles;   // handles on top of every wire
  }

  function renderStage() {
    renderComponents();
    renderWires();
    renderInspector();
    updateStage();
  }

  function applyView() {
    const t = `translate(${view.x} ${view.y}) scale(${view.k})`;
    world.setAttribute('transform', t);
    $('#gridPat').setAttribute('patternTransform', t);
  }

  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  }

  function zoomAt(cx, cy, factor) {
    const r = svg.getBoundingClientRect();
    const k = Math.min(3, Math.max(0.3, view.k * factor));
    const px = cx - r.left, py = cy - r.top;
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }

  function fitView() {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    let x0 = -10, y0 = -10, x1 = BOARD.w + 10, y1 = BOARD.h + 30;
    for (const c of comps) {
      const d = PARTS[c.type];
      x0 = Math.min(x0, c.x - 20); y0 = Math.min(y0, c.y - 30);
      x1 = Math.max(x1, c.x + d.w + 20); y1 = Math.max(y1, c.y + d.h + 40);
    }
    const k = Math.min(1.5, Math.max(0.3, Math.min((r.width - 40) / (x1 - x0), (r.height - 40) / (y1 - y0))));
    view.k = k;
    view.x = (r.width - (x1 - x0) * k) / 2 - x0 * k;
    view.y = (r.height - (y1 - y0) * k) / 2 - y0 * k;
    applyView();
  }

  function updateStage() {
    const duty = machine.sampleDuty();
    const enable = machine.drivenPins();
    const levels = machine.levels();
    for (const c of comps) {
      const el = compEls.get(c.id);
      if (!el) continue;
      const ctx = {
        duty: pin => { const g = c.conn[pin]; return g === undefined || g === null ? null : duty[g]; },
        driven: pin => { const g = c.conn[pin]; return g !== undefined && g !== null && ((enable >>> g) & 1) === 1; },
        powered: isPowered(c)
      };
      PARTS[c.type].update(el, c, ctx);
    }
    for (const el of boardLayer.querySelectorAll('.bpin.gpio')) {
      const g = +el.dataset.pin;
      const out = (enable >>> g) & 1, lv = (levels >>> g) & 1;
      el.classList.toggle('out-hi', out === 1 && duty[g] > 0.02);
      el.classList.toggle('out-lo', out === 1 && duty[g] <= 0.02);
      el.classList.toggle('in-hi', out === 0 && lv === 1);
    }
    const boot = boardLayer.querySelector('[data-board-btn="boot"] .bb-cap');
    if (boot) boot.setAttribute('r', bootPressed ? 5 : 6.5);
  }

  // ---- selection & inspector
  function select(sel) {
    if (simActive()) sel = null;
    selection = sel;
    for (const el of compLayer.children) el.classList.toggle('selected', !!sel && sel.kind === 'comp' && sel.id === el.dataset.id);
    if (wireStyle === 'ortho') renderWires();
    else for (const el of wireLayer.children) el.classList.toggle('selected', !!sel && sel.kind === 'wire' && sel.id === el.dataset.comp && sel.pin === el.dataset.pin);
    renderInspector();
  }

  function gpioOptions(selected) {
    return `<option value="">— not connected —</option>` + GPIO_PINS.map(g =>
      `<option value="${g}"${g === selected ? ' selected' : ''}>${gpioLabel(g)}</option>`).join('');
  }

  function renderInspector() {
    const box = $('#inspector');
    if (!selection || simActive()) { box.hidden = true; return; }
    const c = compById(selection.id);
    if (!c) { box.hidden = true; return; }
    const def = PARTS[c.type];
    box.hidden = false;
    if (selection.kind === 'wire') {
      const g = c.conn[selection.pin];
      box.innerHTML = `
        <div class="insp-head"><b>Wire</b><button class="icon" data-act="close" title="Close">✕</button></div>
        <p class="insp-info">${esc(c.id)}.${esc(selection.pin)} → <b>${targetName(g)}</b></p>
        <div class="insp-actions">
          ${wireStyle === 'ortho' && c.route && c.route[selection.pin] ? '<button data-act="reset-route" title="Remove the corners you placed and route this wire automatically">Reset corners</button>' : ''}
          <button class="danger" data-act="del-wire">Delete wire</button>
        </div>`;
      return;
    }
    const props = def.props.map(p => {
      const v = c.props[p.key];
      if (p.type === 'key') {
        return `<label>${p.label}<input data-prop="${p.key}" maxlength="1" value="${esc(v === ' ' ? '' : v || '')}" placeholder="${v === ' ' ? 'Space' : 'none'}" title="Press this key to push the button"></label>`;
      }
      return `<label>${p.label}<select data-prop="${p.key}"${p.bool ? ' data-bool="1"' : ''}>${p.options.map(([val, text]) =>
        `<option value="${val}"${String(v) === val ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
    }).join('');
    const pins = def.pins.map(p =>
      `<label><span>${esc(pinLabelOf(def, c, p))}</span><select data-pinsel="${p.name}">${gpioOptions(c.conn[p.name])}</select></label>`).join('');
    const power = autoPower ? '' : powerPins(def).map(p => {
      const cur = POWER_PINS[c.conn[p.name]] || '';
      const options = [['', '— not connected —'], ['GND', 'GND'], ['3V3', '3V3']].map(([v, t]) =>
        `<option value="${v}"${cur === v ? ' selected' : ''}>${t}</option>`).join('');
      return `<label><span>${esc(pinLabelOf(def, c, p))} (power)</span><select data-pwrsel="${p.name}">${options}</select></label>`;
    }).join('');
    const warn = isPowered(c) ? '' : `<p class="insp-warn">No power: wire ${def.powerAny ? 'a' : 'the'} supply pin to GND or 3V3.</p>`;
    box.innerHTML = `
      <div class="insp-head"><b>${esc(def.title)}</b><span class="dim">${esc(c.id)}</span><button class="icon" data-act="close" title="Close">✕</button></div>
      ${props}
      <div class="insp-sub">Connections</div>
      ${pins}
      ${power}
      ${warn}
      ${c.type === 'sevenseg' ? '<div class="insp-actions"><button data-act="autowire">Auto-wire to GPIO0…7</button></div>' : ''}
      <div class="insp-actions"><button class="danger" data-act="delete">Delete part</button></div>`;
  }

  $('#inspector').addEventListener('change', e => {
    if (!selection) return;
    const c = compById(selection.id);
    if (!c) return;
    const t = e.target;
    if (t.dataset.prop === 'key') return; // handled by the 'input' listener
    if (t.dataset.prop) {
      let v = t.value;
      if (t.dataset.bool) v = v === 'true';
      c.props[t.dataset.prop] = v;
      const dropped = dropMismatchedPower(c);
      if (dropped.length && !autoPower) toast(`Disconnected ${dropped.map(n => c.id + '.' + n).join(', ')}: it was wired to the other rail`);
    } else if (t.dataset.pwrsel) {
      const pin = t.dataset.pwrsel;
      clearRoute(c, pin);
      if (t.value === '') delete c.conn[pin];
      else powerToast(c, attachPower(c, pin, nearestPowerPin(c, pin, t.value)));
    } else if (t.dataset.pinsel) {
      clearRoute(c, t.dataset.pinsel);
      if (t.value === '') delete c.conn[t.dataset.pinsel];
      else c.conn[t.dataset.pinsel] = +t.value;
    } else return;
    afterPartsChanged();
  });
  $('#inspector').addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.prop !== 'key' || !selection) return;
    const c = compById(selection.id);
    c.props.key = t.value.toLowerCase();
    afterPartsChanged(true);
  });
  $('#inspector').addEventListener('keydown', e => {
    if (e.target.dataset.prop === 'key' && e.key === ' ') {
      e.preventDefault();
      const c = compById(selection.id);
      c.props.key = ' ';
      afterPartsChanged();
    }
  });
  $('#inspector').addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const c = selection && compById(selection.id);
    switch (act.dataset.act) {
      case 'close': select(null); break;
      case 'delete': deleteSelection(); break;
      case 'del-wire': deleteSelection(); break;
      case 'reset-route':
        clearRoute(c, selection.pin);
        renderWires();
        renderInspector();
        scheduleSave();
        break;
      case 'autowire':
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].forEach((n, i) => { c.conn[n] = i; });
        afterPartsChanged();
        break;
    }
  });

  function afterPartsChanged(keepInspector) {
    renderComponents();
    renderWires();
    if (!keepInspector) renderInspector();
    applyInputs();
    updateStage();
    scheduleSave();
    updatePanels(true);
  }

  function deleteSelection() {
    if (!selection) return;
    const c = compById(selection.id);
    if (!c) return;
    if (selection.kind === 'wire') {
      delete c.conn[selection.pin];
      clearRoute(c, selection.pin);
      toast(`Disconnected ${c.id}.${selection.pin}`);
    } else {
      comps = comps.filter(x => x !== c);
      toast(`Deleted ${c.id}`);
    }
    selection = null;
    afterPartsChanged();
  }

  // First grid slot right of the board that doesn't overlap a part and is visible
  // on screen (not hidden under the settings panel); otherwise the first free slot.
  function findFreeSpot(def) {
    const r = svg.getBoundingClientRect();
    const visRight = r.width - 300; // keep clear of the inspector panel
    const overlaps = (x, y) => comps.some(c => {
      const d = PARTS[c.type];
      return x < c.x + d.w + 30 && x + def.w + 30 > c.x && y < c.y + d.h + 40 && y + def.h + 40 > c.y;
    });
    const onScreen = (x, y) => {
      const sx = view.x + x * view.k, sy = view.y + y * view.k;
      return sx >= 0 && sy >= 0 && sx + def.w * view.k <= visRight && sy + (def.h + 30) * view.k <= r.height;
    };
    let fallback = null;
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 8; col++) {
        const x = 250 + col * 110, y = 30 + row * 170;
        if (overlaps(x, y)) continue;
        if (onScreen(x, y)) return { x, y };
        if (!fallback) fallback = { x, y };
      }
    }
    requestAnimationFrame(fitView);
    return fallback || { x: 250, y: 30 };
  }

  function addPart(type) {
    const def = PARTS[type];
    let n = 1;
    const prefix = { led: 'led', button: 'btn', switch: 'sw', sevenseg: 'seg' }[type];
    while (compById(prefix + n)) n++;
    const spot = findFreeSpot(def);
    const c = {
      id: prefix + n, type, x: spot.x, y: spot.y,
      props: Object.assign({}, def.defaults), conn: {}, route: {}
    };
    comps.push(c);
    selection = simActive() ? null : { kind: 'comp', id: c.id };
    afterPartsChanged();
    toast(`Added ${def.title}. Click one of its pins, then a GPIO pin on the board.`);
  }

  $$('[data-add]').forEach(b => b.addEventListener('click', () => addPart(b.dataset.add)));
  $('#zoomIn').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2); });
  $('#zoomOut').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2); });
  $('#zoomFit').addEventListener('click', fitView);

  // ---- wiring
  function pinWorldPos(p) {
    if (p.kind === 'board') return boardPinPos.get(p.key !== undefined ? p.key : p.gpio);
    const c = compById(p.id);
    const pin = findPin(PARTS[c.type], p.pin);
    return { x: c.x + pin.x, y: c.y + pin.y };
  }

  function startPending(p, hint) {
    pending = p;
    pending.pts = [];      // corner points placed so far (horizontal / vertical wires only)
    pending.groups = [];   // number of points each click added
    pending.orient = null;
    svg.classList.add('wiring');
    $('#stageHint').textContent = hint + (wireStyle === 'ortho' ? ' · click to place a point (bends automatically), Backspace to undo' : '') + ' — Esc to cancel';
    $('#stageHint').hidden = false;
  }

  function cancelPending() {
    pending = null;
    pendingWire.setAttribute('d', '');
    svg.classList.remove('wiring');
    $('#stageHint').hidden = true;
  }

  function powerToast(c, dropped) {
    if (dropped.length) toast(`Disconnected ${dropped.map(n => c.id + '.' + n).join(', ')}: ${c.id} now needs it on the other rail`);
  }

  // target: GPIO number, or a power pin key such as 'L0'
  function connect(id, pin, target) {
    const c = compById(id);
    const pwr = isPowerPin(PARTS[c.type], pin);
    // Corners, including the bend into the final pin, are stored from the part towards the board.
    let corners = [];
    if (pending && wireStyle === 'ortho') {
      const end = pending.kind === 'board' ? pinWorldPos({ kind: 'comp', id, pin }) : boardPinPos.get(target);
      corners = pending.pts.concat(end ? legTo(lastPoint(), end, pending.orient || 'h').slice(0, -1) : []);
      if (pending.kind === 'board') corners.reverse();
    }
    cancelPending();
    if (pwr !== (typeof target === 'string')) {
      toast(pwr ? `${id}.${pin} is a supply pin: connect it to GND or 3V3.` : `${id}.${pin} is a signal pin: connect it to a GPIO pin.`, 'error');
      return;
    }
    let dropped = [];
    if (pwr) dropped = attachPower(c, pin, target);
    else c.conn[pin] = target;
    if (!c.route) c.route = {};
    if (corners.length) c.route[pin] = corners;
    else delete c.route[pin];
    selection = simActive() ? null : { kind: 'comp', id };
    afterPartsChanged();
    let note = '';
    if (target === 20 || target === 21) note = ' (note: UART0 pin)';
    toast(`Connected ${id}.${pin} → ${targetName(target)}${note}`, 'ok');
    powerToast(c, dropped);
  }

  function onCompPinClick(id, pin) {
    if (pending && pending.kind === 'board') { connect(id, pin, pending.key !== undefined ? pending.key : pending.gpio); return; }
    const pwr = isPowerPin(PARTS[compById(id).type], pin);
    startPending({ kind: 'comp', id, pin }, `Wiring ${id}.${pin}: click a ${pwr ? 'GND or 3V3' : 'GPIO'} pin on the board`);
  }

  function onBoardPinClick(label) {
    if (POWER_PINS[label]) {
      const rail = POWER_PINS[label];
      if (autoPower) { toast(`${rail}: power is connected automatically. Turn Auto power off to wire it yourself.`); return; }
      if (rail === '5V') { toast('5V: the parts here run from 3.3 V. Use a 3V3 pin.', 'error'); return; }
      if (pending && pending.kind === 'comp') { connect(pending.id, pending.pin, label); return; }
      startPending({ kind: 'board', key: label }, `Wiring ${rail}: click a supply pin on a part`);
      return;
    }
    if (!/^\d+$/.test(label)) { toast(`${label}: connect parts to GPIO pins.`); return; }
    const gpio = +label;
    if (pending && pending.kind === 'comp') { connect(pending.id, pending.pin, gpio); return; }
    startPending({ kind: 'board', gpio }, `Wiring GPIO${gpio}: click a pin on a part`);
  }

  function setWireStyle(style) {
    wireStyle = style === 'ortho' ? 'ortho' : 'curve';
    $('#wireStyle').value = wireStyle;
  }

  $('#wireStyle').addEventListener('change', e => {
    cancelPending();
    setWireStyle(e.target.value);
    renderWires();
    renderInspector();
    scheduleSave();
    if (wireStyle === 'ortho') toast('Horizontal / vertical wires: while wiring, click to place points; the wire bends along the way you first move the mouse. Backspace undoes a point.');
  });

  function setAutoPower(on) {
    autoPower = on;
    const b = $('#autoPower');
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('b').textContent = on ? 'ON' : 'OFF';
    svg.classList.toggle('manual-power', !on);
  }

  $('#autoPower').addEventListener('click', () => {
    cancelPending();
    setAutoPower(!autoPower);
    if (selection && selection.kind === 'wire') {
      const c = compById(selection.id);
      if (!c || isPowerPin(PARTS[c.type], selection.pin)) selection = null;
    }
    afterPartsChanged();
    const unpowered = comps.filter(c => !isPowered(c)).length;
    toast(autoPower ? 'Auto power ON: GND / 3V3 are connected automatically.'
      : `Auto power OFF: wire each part's supply pin to GND or 3V3 on the board${unpowered ? ` (${unpowered} part${unpowered > 1 ? 's' : ''} unpowered)` : ''}.`);
  });

  // ---- pointer interaction
  let drag = null;
  let pointerButton = null;

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    const t = e.target;
    if (e.button === 0) {
      const cpin = t.closest('.cpin');
      if (cpin) { e.preventDefault(); onCompPinClick(cpin.dataset.comp, cpin.dataset.pin); return; }
      const bpin = t.closest('.bpin');
      if (bpin) { e.preventDefault(); onBoardPinClick(bpin.dataset.pin); return; }
      if (pending && wireStyle === 'ortho') {
        e.preventDefault();
        lastMouse = toWorld(e);
        addCornerAt(lastMouse);
        drawPending();
        return;
      }
      const bb = t.closest('[data-board-btn]');
      if (bb) {
        e.preventDefault();
        if (bb.dataset.boardBtn === 'boot') { bootPressed = true; applyInputs(); svg.setPointerCapture(e.pointerId); drag = { type: 'boot' }; }
        else if (simState !== 'stopped') { stop(); run(); toast('Reset'); }
        return;
      }
      const handle = t.closest('.whandle');
      if (handle) {
        e.preventDefault();
        const g = handle.parentNode, c = compById(g.dataset.comp), pin = g.dataset.pin;
        const P = wirePointsOf(c, pin);
        if (!P) return;
        drag = handle.dataset.pt !== undefined
          ? { type: 'wcorner', c, pin, P, i: +handle.dataset.pt, start: toWorld(e), moved: false }
          : { type: 'wseg', c, pin, P, i: +handle.dataset.seg, start: toWorld(e), moved: false };
        svg.setPointerCapture(e.pointerId);
        return;
      }
      const wire = t.closest('.wire');
      if (wire) {
        if (simActive()) toast(SETTINGS_LOCKED);
        select({ kind: 'wire', id: wire.dataset.comp, pin: wire.dataset.pin });
        return;
      }
      const compEl = t.closest('.comp');
      if (compEl) {
        e.preventDefault();
        const c = compById(compEl.dataset.id);
        if (selection?.id !== c.id || selection.kind !== 'comp') select({ kind: 'comp', id: c.id });
        if (t.closest('[data-press]')) {
          pressButton(c, true);
          pointerButton = c;
          svg.setPointerCapture(e.pointerId);
          return;
        }
        const w = toWorld(e);
        drag = { type: 'comp', c, dx: w.x - c.x, dy: w.y - c.y, sx: e.clientX, sy: e.clientY, moved: false, toggle: !!t.closest('[data-toggle]') };
        svg.setPointerCapture(e.pointerId);
        return;
      }
      if (pending) { cancelPending(); return; }
      select(null);
    }
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  });

  svg.addEventListener('dblclick', e => {
    const h = e.target.closest('.whandle.corner');
    if (!h) return;
    const g = h.parentNode, c = compById(g.dataset.comp), pin = g.dataset.pin;
    const P = wirePointsOf(c, pin);
    if (!P) return;
    P.splice(+h.dataset.pt, 1);
    // what is left may now be diagonal: let the renderer bend it, then keep those bends
    setWirePoints(c, pin, P);
    setWirePoints(c, pin, simplifyPoints(wirePointsOf(c, pin)));
    renderWires();
    renderInspector();
    scheduleSave();
  });

  svg.addEventListener('pointermove', e => {
    if (pending) {
      lastMouse = toWorld(e);
      if (wireStyle === 'ortho') trackOrient(lastMouse);
      drawPending();
    }
    if (!drag) return;
    if (drag.type === 'pan') {
      view.x = drag.vx + e.clientX - drag.sx;
      view.y = drag.vy + e.clientY - drag.sy;
      applyView();
    } else if (drag.type === 'wcorner' || drag.type === 'wseg') {
      const w = toWorld(e);
      let pts;
      // snap the distance dragged, so points that sit off the grid (pins) stay in line
      const dx = snap5(w.x - drag.start.x), dy = snap5(w.y - drag.start.y);
      if (drag.type === 'wcorner') {
        const a = drag.P[drag.i];
        pts = moveCorner(drag.P, drag.i, { x: a.x + dx, y: a.y + dy });
      } else {
        const horiz = drag.P[drag.i].y === drag.P[drag.i + 1].y;
        const delta = horiz ? dy : dx;
        if (!delta && !drag.moved) return;
        pts = moveSegment(drag.P, drag.i, delta);
      }
      drag.moved = true;
      setWirePoints(drag.c, drag.pin, pts);
      renderWires();
    } else if (drag.type === 'comp') {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moved = true;
      const w = toWorld(e);
      drag.c.x = Math.round((w.x - drag.dx) / 5) * 5;
      drag.c.y = Math.round((w.y - drag.dy) / 5) * 5;
      compEls.get(drag.c.id).setAttribute('transform', `translate(${drag.c.x} ${drag.c.y})`);
      renderWires();
    }
  });

  function endPointer() {
    if (pointerButton) { pressButton(pointerButton, false); pointerButton = null; }
    if (!drag) return;
    if (drag.type === 'boot') { bootPressed = false; applyInputs(); }
    if ((drag.type === 'wcorner' || drag.type === 'wseg') && drag.moved) {
      const P = wirePointsOf(drag.c, drag.pin);
      if (P) setWirePoints(drag.c, drag.pin, simplifyPoints(P));
      renderWires();
      renderInspector();
      scheduleSave();
    }
    if (drag.type === 'comp') {
      if (drag.moved) scheduleSave();
      else if (!drag.toggle && simActive()) toast(SETTINGS_LOCKED);
      else if (drag.toggle) {
        drag.c.props.on = !drag.c.props.on;
        PARTS.switch.update(compEls.get(drag.c.id), drag.c);
        applyInputs();
        scheduleSave();
      }
    }
    svg.classList.remove('panning');
    drag = null;
  }
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
  }, { passive: false });
  svg.addEventListener('contextmenu', e => e.preventDefault());

  // ---- keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'F5') { e.preventDefault(); if (simState === 'running') pause(); else run(); return; }
    if (e.key === 'F10') { e.preventDefault(); step(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveLocal(); toast('Project saved in this browser', 'ok'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (simState === 'running') stop(); run(); return; }
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'Escape') { cancelPending(); select(null); return; }
    if (e.key === 'Backspace' && pending) {
      e.preventDefault();
      if (pending.groups.length) pending.pts.splice(-pending.groups.pop());
      pending.orient = null;
      drawPending();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); return; }
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    let hit = false;
    for (const c of comps) if (c.type === 'button' && c.props.key && c.props.key === k) { pressButton(c, true); hit = true; }
    if (hit) e.preventDefault();
  });
  document.addEventListener('keyup', e => {
    if (e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    for (const c of comps) if (c.type === 'button' && c.props.key && c.props.key === k) { pressButton(c, false); e.preventDefault(); }
  });
  window.addEventListener('blur', () => { for (const c of comps) if (c.pressed) pressButton(c, false); });

  // ================================================================ bottom panels

  let activeTab = 'serial';
  $$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    $$('.tabs [data-tab]').forEach(x => x.classList.toggle('active', x === b));
    $$('.tab-body > section').forEach(s => { s.hidden = s.id !== 'tab-' + activeTab; });
    updatePanels(true);
  }));

  // ---- serial monitor
  const serialOut = $('#serialOut');
  let decoder = new TextDecoder();
  let serialTail = null;

  function serialAtBottom() { return serialOut.scrollHeight - serialOut.scrollTop - serialOut.clientHeight < 30; }

  function flushSerial() {
    if (!machine.tx.length) return;
    const text = decoder.decode(new Uint8Array(machine.tx), { stream: true });
    machine.tx.length = 0;
    const stick = serialAtBottom();
    if (!serialTail) { serialTail = document.createTextNode(''); serialOut.appendChild(serialTail); }
    serialTail.data += text;
    if (serialTail.data.length > 200000) serialTail.data = serialTail.data.slice(-150000);
    if (stick) serialOut.scrollTop = serialOut.scrollHeight;
    if (activeTab !== 'serial') $('[data-tab="serial"]').classList.add('badge');
  }

  function clearSerial() {
    serialOut.textContent = '';
    serialTail = null;
    decoder = new TextDecoder();
    machine.tx.length = 0;
  }

  $('#serialForm').addEventListener('submit', e => {
    e.preventDefault();
    const inp = $('#serialIn');
    const eol = { lf: '\n', cr: '\r', crlf: '\r\n', none: '' }[$('#serialEol').value];
    const bytes = new TextEncoder().encode(inp.value + eol);
    if (!bytes.length) return;
    machine.uartReceive(bytes);
    inp.value = '';
    if (simState !== 'running') toast('Queued in UART0 RX FIFO — run the program to receive it');
  });
  $('#serialClear').addEventListener('click', clearSerial);

  // ---- messages: simulator errors, warnings and notices (kept apart from the program's serial output)
  const msgList = $('#msgList'), msgCount = $('#msgCount');
  const MSG_ICONS = { error: '✖', warn: '⚠', info: 'ℹ' };
  let msgTotals = { error: 0, warn: 0, info: 0 }, msgUnseen = 0;

  function addMessage(level, text, line) {
    if (!msgTotals.error && !msgTotals.warn && !msgTotals.info) msgList.textContent = '';
    msgTotals[level]++;
    const stick = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 30;
    const row = document.createElement('div');
    row.className = 'msg ' + level;
    row.innerHTML = `<span class="mi">${MSG_ICONS[level]}</span><span class="mt mono">${machine.timeSeconds.toFixed(3)} s</span>
      <span class="mx">${esc(text)}</span>${line ? `<button type="button" class="ml mono" data-line="${line}">line ${line}</button>` : ''}`;
    msgList.appendChild(row);
    if (stick) msgList.scrollTop = msgList.scrollHeight;
    if (activeTab !== 'messages' && level !== 'info') { msgUnseen++; msgCount.textContent = msgUnseen; msgCount.hidden = false; }
    updateMsgSummary();
  }

  function updateMsgSummary() {
    const parts = [];
    if (msgTotals.error) parts.push(`${msgTotals.error} error${msgTotals.error > 1 ? 's' : ''}`);
    if (msgTotals.warn) parts.push(`${msgTotals.warn} warning${msgTotals.warn > 1 ? 's' : ''}`);
    if (msgTotals.info) parts.push(`${msgTotals.info} notice${msgTotals.info > 1 ? 's' : ''}`);
    $('#msgSummary').textContent = parts.join(' · ');
  }

  function seenMessages() { msgUnseen = 0; msgCount.hidden = true; }

  function clearMessages() {
    msgTotals = { error: 0, warn: 0, info: 0 };
    msgList.innerHTML = '<div class="msg-empty">No messages. Errors and warnings from the simulator appear here.</div>';
    seenMessages();
    updateMsgSummary();
  }

  msgList.addEventListener('click', e => {
    const b = e.target.closest('[data-line]');
    if (b) gotoLine(+b.dataset.line);
  });
  $('#msgClear').addEventListener('click', clearMessages);

  // ---- registers
  const regsEl = $('#regs');
  let prevRegs = null;
  regsEl.innerHTML = RVAsm.ABI_NAMES.map((n, i) =>
    `<div class="reg"><span class="rn">x${i}</span><span class="ra">${n}</span><span class="rv" id="rv${i}"></span></div>`).join('') +
    `<div class="reg pc"><span class="rn">pc</span><span class="ra"></span><span class="rv" id="rvpc"></span></div>`;

  function fmtReg(v) {
    switch ($('#regFmt').value) {
      case 'dec': return String(v | 0);
      case 'udec': return String(v >>> 0);
      default: return hex8(v);
    }
  }

  function updateRegs(force) {
    const x = machine.core.x;
    const showChange = simState === 'paused' || (simState === 'running' && rate() <= 1000);
    for (let i = 0; i < 32; i++) {
      const el = $('#rv' + i);
      el.textContent = fmtReg(x[i]);
      el.title = `${hex8(x[i])}  =  ${x[i] | 0}  (unsigned ${x[i] >>> 0})`;
      el.parentNode.classList.toggle('changed', !!(showChange && prevRegs && prevRegs[i] !== x[i]));
    }
    $('#rvpc').textContent = hex8(machine.core.pc);
    if (force || showChange) prevRegs = Int32Array.from(x);
    $('#cpuInfo').textContent = `cycles ${machine.core.cycle.toLocaleString()} · time ${machine.timeSeconds.toFixed(6)} s`;
  }
  $('#regFmt').addEventListener('change', () => updateRegs(true));

  // ---- memory
  function memAddr() {
    const s = $('#memAddr').value.trim() || hex8(RVAsm.DATA_BASE);
    if (program && program.symbols[s] !== undefined) return program.symbols[s];
    if (s.toLowerCase() === 'sp') return machine.core.x[2] >>> 0;
    const v = Number(s);
    return Number.isFinite(v) ? v >>> 0 : RVAsm.DATA_BASE;
  }

  function updateMemory() {
    const base = (memAddr() & ~0xf) >>> 0;
    const symAt = new Map();
    if (program) for (const [k, v] of Object.entries(program.symbols)) if (!symAt.has(v)) symAt.set(v, k);
    let out = '';
    for (let r = 0; r < 16; r++) {
      const a = (base + r * 16) >>> 0;
      let hx = '', asc = '';
      for (let i = 0; i < 16; i++) {
        const o = machine.offset((a + i) >>> 0);
        if (o < 0) { hx += '-- '; asc += ' '; continue; }
        const b = machine.sram[o];
        const sym = symAt.get((a + i) >>> 0);
        const cell = b.toString(16).padStart(2, '0');
        hx += sym ? `<span class="msym" title="${esc(sym)}">${cell}</span> ` : cell + ' ';
        if (i === 7) hx += ' ';
        asc += b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '.';
      }
      out += `<div><span class="maddr">${hex8(a)}</span>  ${hx} <span class="masc">${asc}</span></div>`;
    }
    $('#memDump').innerHTML = out;
  }
  $('#memForm').addEventListener('submit', e => { e.preventDefault(); updateMemory(); });
  $('#memPresets').addEventListener('change', e => { if (e.target.value) { $('#memAddr').value = e.target.value; updateMemory(); } e.target.value = ''; });

  // ---- GPIO table
  function iomuxText(r, g) {
    const f = [machine.pinFunction(g) || `F${(r >>> 12) & 7}?`];
    if (r & (1 << 9)) f.push('IE');
    if (r & (1 << 8)) f.push('PU');
    if (r & (1 << 7)) f.push('PD');
    return f.join(' ');
  }
  function updateGpio() {
    const en = machine.gpioEnable, out = machine.gpioOut, lv = machine.levels(), floating = machine.floatingPins();
    const users = new Map();
    for (const c of comps) for (const [pin, g] of Object.entries(c.conn)) {
      if (!users.has(g)) users.set(g, []);
      users.get(g).push(`${c.id}.${pin}`);
    }
    $('#gpioBody').innerHTML = GPIO_PINS.map(g => {
      const isOut = (en >>> g) & 1, level = (lv >>> g) & 1, routed = (machine.gpioFnMask >>> g) & 1;
      const dir = !routed ? `<span class="tag in" title="IO MUX function ${esc(machine.pinFunction(g) || 'reserved')} is selected: GPIO_OUT / GPIO_ENABLE do not reach this pin">${isOut ? 'OUTPUT (not routed)' : 'not GPIO'}</span>`
        : isOut ? '<span class="tag out">OUTPUT</span>' : '<span class="tag in">input</span>';
      return `<tr><td>GPIO${g}</td><td class="dim">${GPIO_NOTES[g] || ''}</td>
        <td>${dir}</td>
        <td class="mono">${(out >>> g) & 1}</td>
        <td class="mono dim">${iomuxText(machine.iomux[g], g)}</td>
        <td>${(floating >>> g) & 1 ? '<span class="lvl float" title="Nothing drives or pulls this pin: its level is undefined on real hardware">floating</span>' : `<span class="lvl ${level ? 'hi' : 'lo'}">${level ? 'HIGH' : 'LOW'}</span>`}</td>
        <td class="dim">${(users.get(g) || []).join(', ')}</td></tr>`;
    }).join('');
    $('#gpioRegs').textContent = `GPIO_OUT_REG = ${hex8(out)}   GPIO_ENABLE_REG = ${hex8(en)}   GPIO_IN_REG = ${hex8(lv)}`;
  }

  // ---- listing
  let listingRows = new Map();
  let lastListingPc = -1;
  function renderListing() {
    if (!program) return;
    const rows = program.listing.map(it => {
      const code = it.words ? it.words.map(w => w.toString(16).padStart(8, '0')).join(' ')
        : it.bytes.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(' ') + (it.bytes.length > 8 ? ' …' : '');
      return `<tr data-addr="${it.addr}" data-line="${it.line}"><td class="maddr">${hex8(it.addr)}</td><td class="mono">${code}</td><td class="dim">${it.line}</td><td class="src">${highlightLine(it.src.trim())}</td></tr>`;
    }).join('');
    $('#listBody').innerHTML = rows;
    listingRows = new Map();
    for (const tr of $('#listBody').children) listingRows.set(+tr.dataset.addr, tr);
    lastListingPc = -1;
    const syms = Object.entries(program.symbols).sort((a, b) => a[1] - b[1]);
    $('#symList').innerHTML = syms.map(([k, v]) => `<span><b>${esc(k)}</b> ${hex8(v)}</span>`).join('');
    $('#memPresets').innerHTML = '<option value="">symbols…</option><option value="sp">sp (stack)</option>' +
      syms.map(([k]) => `<option>${esc(k)}</option>`).join('');
  }
  $('#listBody').addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (tr) gotoLine(+tr.dataset.line);
  });

  function updateListing() {
    const pc = simState === 'stopped' ? -1 : machine.core.pc;
    if (pc === lastListingPc) return;
    const old = listingRows.get(lastListingPc);
    if (old) old.classList.remove('cur');
    const tr = listingRows.get(pc);
    if (tr) {
      tr.classList.add('cur');
      const box = $('#tab-listing');
      if (tr.offsetTop < box.scrollTop || tr.offsetTop > box.scrollTop + box.clientHeight - 30) box.scrollTop = tr.offsetTop - box.clientHeight / 3;
    }
    lastListingPc = pc;
  }

  function updatePanels(force) {
    switch (activeTab) {
      case 'regs': updateRegs(force); break;
      case 'mem': updateMemory(); break;
      case 'gpio': updateGpio(); break;
      case 'listing': updateListing(); break;
      case 'serial': $('[data-tab="serial"]').classList.remove('badge'); break;
      case 'messages': seenMessages(); break;
    }
  }

  // ================================================================ projects

  function normalizeComps(list) {
    const out = [];
    for (const c of list || []) {
      const def = PARTS[c.type];
      if (!def || out.some(o => o.id === c.id)) continue;
      const conn = {};
      for (const p of def.pins) {
        const g = c.conn && c.conn[p.name];
        if (g !== undefined && g !== null && GPIO_PINS.includes(+g)) conn[p.name] = +g;
      }
      for (const p of powerPins(def)) {
        const k = c.conn && c.conn[p.name];
        if (POWER_PINS[k] === 'GND' || POWER_PINS[k] === '3V3') conn[p.name] = k;
      }
      const route = {};
      for (const pin of Object.keys(conn)) {
        const r = c.route && c.route[pin];
        if (!Array.isArray(r)) continue;
        const pts = r.map(q => ({ x: +(q && q.x), y: +(q && q.y) })).filter(q => isFinite(q.x) && isFinite(q.y));
        if (pts.length) route[pin] = pts;
      }
      out.push({ id: String(c.id), type: c.type, x: +c.x || 0, y: +c.y || 0, props: Object.assign({}, def.defaults, c.props), conn, route });
    }
    return out;
  }

  function serializeProject() {
    return {
      app: 'rvsim-c3', version: 1,
      code: ta.value,
      autoPower,
      wireStyle,
      components: comps.map(c => ({ id: c.id, type: c.type, x: c.x, y: c.y, props: c.props, conn: c.conn, route: c.route })),
      breakpoints: [...breakpointLines]
    };
  }

  function loadProject(p, opts = {}) {
    if (simState !== 'stopped') stop();
    ta.value = p.code || '';
    setAutoPower(p.autoPower !== false);
    setWireStyle(p.wireStyle);
    comps = normalizeComps(p.components);
    breakpointLines = new Set((p.breakpoints || []).filter(n => Number.isInteger(n)));
    selection = null;
    cancelPending();
    program = null;
    loadedSource = null;
    errorLines = new Map();
    currentLine = 0;
    ta.scrollTop = 0;
    renderEditor();
    renderStage();
    applyInputs();
    const res = assembleNow(true);
    if (!res) { toast('Project loaded — it has assembly errors', 'error'); $('#listBody').innerHTML = ''; }
    requestAnimationFrame(fitView);
    clearSerial();
    clearMessages();
    if (!opts.noSave) scheduleSave();
    updateAll(true);
  }

  let saveTimer = 0;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 600); }
  function saveLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(serializeProject())); } catch (_) { /* storage unavailable */ }
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // examples menu
  const exMenu = $('#examplesMenu');
  exMenu.innerHTML = EXAMPLES.map(ex =>
    `<button data-ex="${ex.id}"><b>${esc(ex.name)}</b><span>${esc(ex.description)}</span></button>`).join('');
  function closeMenus() { $$('.menu').forEach(m => m.classList.remove('open')); }
  $$('.menu > button').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const m = b.parentNode, open = m.classList.contains('open');
    closeMenus();
    if (!open) m.classList.add('open');
  }));
  document.addEventListener('click', closeMenus);
  exMenu.addEventListener('click', e => {
    const b = e.target.closest('[data-ex]');
    if (!b) return;
    const ex = EXAMPLES.find(x => x.id === b.dataset.ex);
    const pristine = EXAMPLES.some(x => x.code === ta.value) || ta.value.trim() === BLANK.trim() || !ta.value.trim();
    if (!pristine && !confirm(`Load example "${ex.name}"? Your current program and parts will be replaced.\n(Tip: use Save first to keep them.)`)) return;
    loadProject({ code: ex.code, components: JSON.parse(JSON.stringify(ex.components)) });
    toast(`Loaded example: ${ex.name}`, 'ok');
  });

  $('#btnNew').addEventListener('click', () => {
    if (!confirm('Start a new empty project? Unsaved changes will be lost.')) return;
    loadProject({ code: BLANK, components: [] });
  });

  $('#saveJson').addEventListener('click', () => {
    saveLocal();
    download('esp32c3-project.json', JSON.stringify(serializeProject(), null, 2), 'application/json');
  });
  $('#saveAsm').addEventListener('click', () => download('main.S', ta.value, 'text/plain'));
  $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const text = await f.text();
    if (/\.json$/i.test(f.name)) {
      try {
        const p = JSON.parse(text);
        if (typeof p.code !== 'string') throw new Error('not a project file');
        loadProject(p);
        toast(`Opened ${f.name}`, 'ok');
      } catch (err) {
        toast('Could not open project: ' + err.message, 'error');
      }
    } else {
      loadProject({ code: text, components: comps, breakpoints: [] });
      toast(`Opened ${f.name} (parts kept)`, 'ok');
    }
  });

  // share link (compressed project in the URL hash)
  function b64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  async function encodeProject() {
    const bytes = new TextEncoder().encode(JSON.stringify(serializeProject()));
    if (window.CompressionStream) {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return 'z' + b64url(new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    return 'j' + b64url(bytes);
  }
  async function decodeProject(s) {
    let bytes = unb64url(s.slice(1));
    if (s[0] === 'z') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  $('#btnShare').addEventListener('click', async () => {
    const enc = await encodeProject();
    const url = location.href.split('#')[0] + '#p=' + enc;
    history.replaceState(null, '', '#p=' + enc);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied to clipboard', 'ok');
    } catch (_) {
      prompt('Copy this link to share your project:', url);
    }
  });

  // ================================================================ layout splitters

  function splitter(el, onMove) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const move = ev => onMove(ev);
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        try { localStorage.setItem(STORE_KEY + '-layout', JSON.stringify({ left: layout.style.getPropertyValue('--left'), bottom: layout.style.getPropertyValue('--bottom') })); } catch (_) { /* ignore */ }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }
  const layout = $('#layout');
  splitter($('#splitV'), e => {
    const r = layout.getBoundingClientRect();
    const px = Math.min(r.width - 360, Math.max(280, e.clientX - r.left));
    layout.style.setProperty('--left', px + 'px');
  });
  splitter($('#splitH'), e => {
    const r = $('.right-pane').getBoundingClientRect();
    const h = Math.min(r.height - 160, Math.max(120, r.bottom - e.clientY));
    layout.style.setProperty('--bottom', h + 'px');
  });

  // ================================================================ theme

  const THEME_KEY = 'rvsim-c3-theme';
  function showTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    const b = $('#btnTheme'), label = light ? 'Switch to dark theme' : 'Switch to light theme';
    b.textContent = light ? '☾' : '☀';
    b.title = label;
    b.setAttribute('aria-label', label);
  }
  $('#btnTheme').addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* storage unavailable */ }
    showTheme();
  });
  // Follow the system theme until the user picks one.
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* ignore */ }
      if (saved) return;
      document.documentElement.dataset.theme = e.matches ? 'light' : 'dark';
      showTheme();
    });
  }
  showTheme();

  // ================================================================ init

  async function init() {
    boardLayer.innerHTML = boardSvg();
    try {
      const l = JSON.parse(localStorage.getItem(STORE_KEY + '-layout') || 'null');
      if (l && l.left) layout.style.setProperty('--left', l.left);
      if (l && l.bottom) layout.style.setProperty('--bottom', l.bottom);
      const sp = localStorage.getItem(STORE_KEY + '-speed');
      if (sp && $(`#speedSel option[value="${sp}"]`)) $('#speedSel').value = sp;
    } catch (_) { /* ignore */ }

    let project = null;
    const m = /#p=([zj][\w-]+)/.exec(location.hash);
    if (m) {
      try { project = await decodeProject(m[1]); toast('Loaded shared project', 'ok'); } catch (_) { toast('Shared link is invalid', 'error'); }
    }
    if (!project) {
      try { project = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { project = null; }
    }
    if (!project || typeof project.code !== 'string') {
      const ex = EXAMPLES[0];
      project = { code: ex.code, components: JSON.parse(JSON.stringify(ex.components)) };
    }
    loadProject(project, { noSave: true });
    updateControls();
    applyView();
    window.addEventListener('resize', () => { if (!comps.length) fitView(); });
  }

  init();
})();
