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
  const GPIO_NOTES = { 2: 'strapping', 8: 'strapping', 9: 'BOOT button', 18: 'USB D-', 19: 'USB D+', 20: 'UART0 RX', 21: 'UART0 TX' };
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
  let pending = null;          // wire being drawn: {kind:'comp', id, pin} | {kind:'board', gpio}
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
    applyInputs();
    clearSerial();
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
      appendSystem(`■ ${machine.haltMessage}`);
      setCurrentLine(0);
    } else if (r === 'error') {
      simState = 'halted';
      const line = program && program.addrToLine.get(machine.error.pc);
      appendSystem(`✖ ${machine.error.message}${line ? ` (line ${line})` : ''}`, true);
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

  function updateControls() {
    const running = simState === 'running';
    $('#btnRun').disabled = running;
    $('#btnPause').disabled = !running;
    $('#btnStop').disabled = simState === 'stopped';
    $('#btnRun').innerHTML = simState === 'paused' ? '▶ Resume' : '▶ Run';
    document.body.dataset.sim = simState;
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

  function applyInputs() {
    const pull = new Array(22).fill(0);   // 0 none, 1 up, -1 down
    const force = new Array(22).fill(null);
    pull[9] = 1;                         // BOOT button has an external pull-up
    if (bootPressed) force[9] = 0;
    for (const c of comps) {
      const g = c.conn['1'];
      if (g === undefined || g === null) continue;
      if (c.type === 'button') {
        if (c.props.mode === 'pulldown') {
          if (!pull[g]) pull[g] = -1;
          if (c.pressed && force[g] === null) force[g] = 1;
        } else {
          pull[g] = 1;
          if (c.pressed) force[g] = 0;
        }
      } else if (c.type === 'switch') {
        force[g] = c.props.on ? 1 : 0;
      }
    }
    let level = 0;
    for (let i = 0; i < 22; i++) {
      const v = force[i] !== null ? force[i] : pull[i] > 0 ? 1 : 0;
      if (v) level |= 1 << i;
    }
    machine.setExternal(level);
    if (simState !== 'running') updateAll(true);
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
  const boardPinPos = new Map();

  function boardSvg() {
    let pins = '';
    const pin = (label, x, y, side) => {
      const isGpio = /^\d+$/.test(label);
      if (isGpio) boardPinPos.set(+label, { x, y, side });
      const tip = isGpio ? gpioLabel(+label) : label === 'RST' ? 'RST (chip enable)' : label + ' (power — connected automatically)';
      const tx = side === 'L' ? x + 13 : x - 13;
      const text = isGpio ? 'IO' + label : label;
      return `<g class="bpin${isGpio ? ' gpio' : ' power'}" data-pin="${label}" transform="translate(${x} ${y})">
          <rect x="-8" y="-8" width="16" height="16" rx="2" class="pin-pad"/>
          <circle r="4.2" class="pin-hole"/><circle r="9" class="pin-hit"/>
          <title>${esc(tip)}</title>
        </g>
        <text x="${tx}" y="${y + 3}" class="pin-label${isGpio ? '' : ' pwr'}" text-anchor="${side === 'L' ? 'start' : 'end'}">${text}</text>`;
    };
    LEFT_PINS.forEach((l, i) => { pins += pin(l, BOARD.lx, BOARD.y0 + i * BOARD.pitch, 'L'); });
    RIGHT_PINS.forEach((l, i) => { pins += pin(l, BOARD.rx, BOARD.y0 + i * BOARD.pitch, 'R'); });
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
      const pins = def.pins.map(p => {
        const g = c.conn[p.name];
        const conn = g !== undefined && g !== null;
        return `<g class="cpin${conn ? ' connected' : ''}" data-comp="${c.id}" data-pin="${p.name}" transform="translate(${p.x} ${p.y})">
            <circle r="8" class="pin-hit"/><circle r="3.4" class="dot"/>
            <title>${esc(c.id)} · ${esc(p.label)}${conn ? ' → GPIO' + g : ' — click, then click a GPIO pin on the board'}</title>
          </g>`;
      }).join('');
      return `<g class="comp${sel ? ' selected' : ''}" data-id="${c.id}" transform="translate(${c.x} ${c.y})">
          <rect class="sel-box" x="-8" y="-14" width="${def.w + 16}" height="${def.h + 22}" rx="6"/>
          <g class="body">${def.render(c)}</g>
          ${pins}
          <text class="comp-label" x="${def.w / 2}" y="${def.h + 20}" text-anchor="middle">${esc(c.id)}</text>
        </g>`;
    }).join('');
    compEls = new Map();
    for (const el of compLayer.children) compEls.set(el.dataset.id, el);
  }

  function wireColor(g) { return WIRE_COLORS[GPIO_PINS.indexOf(g) % WIRE_COLORS.length]; }

  function wirePath(ax, ay, dir, bp) {
    const dy = dir === 'up' ? -1 : 1;
    const reach = Math.min(90, 26 + Math.abs(ay - bp.y) * 0.25);
    const out = Math.max(40, Math.min(160, Math.abs(bp.x - ax) * 0.35));
    const c2x = bp.x + (bp.side === 'L' ? -out : out);
    return `M${ax} ${ay} C${ax} ${ay + dy * reach} ${c2x} ${bp.y} ${bp.x} ${bp.y}`;
  }

  function renderWires() {
    let html = '';
    for (const c of comps) {
      const def = PARTS[c.type];
      for (const p of def.pins) {
        const g = c.conn[p.name];
        if (g === undefined || g === null) continue;
        const bp = boardPinPos.get(g);
        if (!bp) continue;
        const d = wirePath(c.x + p.x, c.y + p.y, p.dir, bp);
        const sel = selection && selection.kind === 'wire' && selection.id === c.id && selection.pin === p.name;
        html += `<g class="wire${sel ? ' selected' : ''}" data-comp="${c.id}" data-pin="${p.name}">
            <path d="${d}" class="wire-outline"/>
            <path d="${d}" class="wire-core" stroke="${wireColor(g)}"/>
            <path d="${d}" class="wire-hit"/>
            <title>${esc(c.id)}.${esc(p.name)} → GPIO${g} (click to select, Delete to remove)</title>
          </g>`;
      }
    }
    wireLayer.innerHTML = html;
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
    const enable = machine.gpioEnable;
    const levels = machine.levels();
    for (const c of comps) {
      const el = compEls.get(c.id);
      if (!el) continue;
      const ctx = {
        duty: pin => { const g = c.conn[pin]; return g === undefined || g === null ? null : duty[g]; },
        driven: pin => { const g = c.conn[pin]; return g !== undefined && g !== null && ((enable >>> g) & 1) === 1; }
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
    selection = sel;
    for (const el of compLayer.children) el.classList.toggle('selected', !!sel && sel.kind === 'comp' && sel.id === el.dataset.id);
    for (const el of wireLayer.children) el.classList.toggle('selected', !!sel && sel.kind === 'wire' && sel.id === el.dataset.comp && sel.pin === el.dataset.pin);
    renderInspector();
  }

  function gpioOptions(selected) {
    return `<option value="">— not connected —</option>` + GPIO_PINS.map(g =>
      `<option value="${g}"${g === selected ? ' selected' : ''}>${gpioLabel(g)}</option>`).join('');
  }

  function renderInspector() {
    const box = $('#inspector');
    if (!selection) { box.hidden = true; return; }
    const c = compById(selection.id);
    if (!c) { box.hidden = true; return; }
    const def = PARTS[c.type];
    box.hidden = false;
    if (selection.kind === 'wire') {
      const g = c.conn[selection.pin];
      box.innerHTML = `
        <div class="insp-head"><b>Wire</b><button class="icon" data-act="close" title="Close">✕</button></div>
        <p class="insp-info">${esc(c.id)}.${esc(selection.pin)} → <b>GPIO${g}</b></p>
        <div class="insp-actions"><button class="danger" data-act="del-wire">Delete wire</button></div>`;
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
      `<label><span>${esc(p.label)}</span><select data-pinsel="${p.name}">${gpioOptions(c.conn[p.name])}</select></label>`).join('');
    box.innerHTML = `
      <div class="insp-head"><b>${esc(def.title)}</b><span class="dim">${esc(c.id)}</span><button class="icon" data-act="close" title="Close">✕</button></div>
      ${props}
      <div class="insp-sub">Connections</div>
      ${pins}
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
    } else if (t.dataset.pinsel) {
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
      props: Object.assign({}, def.defaults), conn: {}
    };
    comps.push(c);
    selection = { kind: 'comp', id: c.id };
    afterPartsChanged();
    toast(`Added ${def.title}. Click one of its pins, then a GPIO pin on the board.`);
  }

  $$('[data-add]').forEach(b => b.addEventListener('click', () => addPart(b.dataset.add)));
  $('#zoomIn').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2); });
  $('#zoomOut').addEventListener('click', () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2); });
  $('#zoomFit').addEventListener('click', fitView);

  // ---- wiring
  function pinWorldPos(p) {
    if (p.kind === 'board') return boardPinPos.get(p.gpio);
    const c = compById(p.id);
    const pin = PARTS[c.type].pins.find(q => q.name === p.pin);
    return { x: c.x + pin.x, y: c.y + pin.y };
  }

  function startPending(p, hint) {
    pending = p;
    svg.classList.add('wiring');
    $('#stageHint').textContent = hint + ' — Esc to cancel';
    $('#stageHint').hidden = false;
  }

  function cancelPending() {
    pending = null;
    pendingWire.setAttribute('d', '');
    svg.classList.remove('wiring');
    $('#stageHint').hidden = true;
  }

  function connect(id, pin, gpio) {
    const c = compById(id);
    c.conn[pin] = gpio;
    cancelPending();
    selection = { kind: 'comp', id };
    afterPartsChanged();
    let note = '';
    if (gpio === 20 || gpio === 21) note = ' (note: UART0 pin)';
    toast(`Connected ${id}.${pin} → GPIO${gpio}${note}`, 'ok');
  }

  function onCompPinClick(id, pin) {
    if (pending && pending.kind === 'board') { connect(id, pin, pending.gpio); return; }
    startPending({ kind: 'comp', id, pin }, `Wiring ${id}.${pin}: click a GPIO pin on the board`);
  }

  function onBoardPinClick(label) {
    if (!/^\d+$/.test(label)) {
      toast(`${label}: ground/power are connected automatically — connect parts to GPIO pins.`);
      return;
    }
    const gpio = +label;
    if (pending && pending.kind === 'comp') { connect(pending.id, pending.pin, gpio); return; }
    startPending({ kind: 'board', gpio }, `Wiring GPIO${gpio}: click a pin on a part`);
  }

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
      const bb = t.closest('[data-board-btn]');
      if (bb) {
        e.preventDefault();
        if (bb.dataset.boardBtn === 'boot') { bootPressed = true; applyInputs(); svg.setPointerCapture(e.pointerId); drag = { type: 'boot' }; }
        else if (simState !== 'stopped') { stop(); run(); toast('Reset'); }
        return;
      }
      const wire = t.closest('.wire');
      if (wire) { select({ kind: 'wire', id: wire.dataset.comp, pin: wire.dataset.pin }); return; }
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

  svg.addEventListener('pointermove', e => {
    if (pending) {
      const a = pinWorldPos(pending), w = toWorld(e);
      pendingWire.setAttribute('d', `M${a.x} ${a.y} L${w.x} ${w.y}`);
    }
    if (!drag) return;
    if (drag.type === 'pan') {
      view.x = drag.vx + e.clientX - drag.sx;
      view.y = drag.vy + e.clientY - drag.sy;
      applyView();
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
    if (drag.type === 'comp') {
      if (drag.moved) scheduleSave();
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

  function appendSystem(msg, isErr) {
    flushSerial();
    const stick = serialAtBottom();
    const s = document.createElement('div');
    s.className = 'sys' + (isErr ? ' err' : '');
    s.textContent = msg;
    serialOut.appendChild(s);
    serialTail = null;
    if (stick) serialOut.scrollTop = serialOut.scrollHeight;
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
  function updateGpio() {
    const en = machine.gpioEnable, out = machine.gpioOut, lv = machine.levels();
    const users = new Map();
    for (const c of comps) for (const [pin, g] of Object.entries(c.conn)) {
      if (!users.has(g)) users.set(g, []);
      users.get(g).push(`${c.id}.${pin}`);
    }
    $('#gpioBody').innerHTML = GPIO_PINS.map(g => {
      const isOut = (en >>> g) & 1, level = (lv >>> g) & 1;
      return `<tr><td>GPIO${g}</td><td class="dim">${GPIO_NOTES[g] || ''}</td>
        <td>${isOut ? '<span class="tag out">OUTPUT</span>' : '<span class="tag in">input</span>'}</td>
        <td class="mono">${(out >>> g) & 1}</td>
        <td><span class="lvl ${level ? 'hi' : 'lo'}">${level ? 'HIGH' : 'LOW'}</span></td>
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
      out.push({ id: String(c.id), type: c.type, x: +c.x || 0, y: +c.y || 0, props: Object.assign({}, def.defaults, c.props), conn });
    }
    return out;
  }

  function serializeProject() {
    return {
      app: 'rvsim-c3', version: 1,
      code: ta.value,
      components: comps.map(c => ({ id: c.id, type: c.type, x: c.x, y: c.y, props: c.props, conn: c.conn })),
      breakpoints: [...breakpointLines]
    };
  }

  function loadProject(p, opts = {}) {
    if (simState !== 'stopped') stop();
    ta.value = p.code || '';
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
