/*
 * Peripheral parts that can be placed on the breadboard.
 *
 * Each part definition provides:
 *   w, h                 size of the part in world units
 *   size(c)              optional: { w, h } when the size depends on the part's settings
 *   pins                 signal pins that can be wired to a GPIO
 *   props                editable properties (shown in the inspector)
 *   render(c, o)         SVG markup (local coordinates); o.auto = power pins wired automatically
 *   update(el, c, ctx)   refresh visuals; ctx.duty(pinName) -> 0..1 or null, ctx.powered,
 *                        ctx.device = the part's chip model, if it has one (see app.js syncDevices)
 *   pinLabel(c, p)       optional: pin label that depends on the part's settings
 *   power                supply pins (GND / 3V3); shown and wired by hand when auto power is off
 *   powerAny             true if any one supply pin is enough (they are joined inside the part)
 *   supplies             optional: board rails the supply pins may use (default ['GND', '3V3'])
 *   rail(c, pin)         rail ('GND' | '3V3' | '5V') a supply pin needs with the current settings
 *   setRail(c, pin, r)   change the settings so that supply pin belongs on rail r
 */
(function (root) {
  'use strict';

  const LED_COLORS = {
    red: '#ff3b30', green: '#30e04a', blue: '#3a8bff', yellow: '#ffd60a',
    orange: '#ff8c1a', white: '#f5f7ff', purple: '#c86bff'
  };
  const CAP_COLORS = {
    red: '#e5383b', green: '#2fbf71', blue: '#3a86ff', yellow: '#ffd23f',
    black: '#2b2d31', white: '#eceff4'
  };

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Fixed supply terminal drawn at (x, y): a ground symbol or a "3V3" label.
  const supply = (vcc, x, y, o) => o && !o.auto ? '' : vcc
    ? `<text x="${x}" y="${y + 6}" class="tiny" text-anchor="middle">3V3</text>`
    : `<path d="M${x - 3} ${y} h6 M${x - 2} ${y + 3} h4 M${x - 1} ${y + 6} h2" class="gnd-sym"/>`;
  const opts = list => list.map(v => Array.isArray(v) ? v : [v, v[0].toUpperCase() + v.slice(1)]);

  const PARTS = {
    led: {
      title: 'LED',
      w: 40, h: 86,
      pins: [{ name: 'A', label: 'Anode (+)', x: 14, y: 86, dir: 'down' }],
      power: [{ name: 'K', x: 26, y: 86, dir: 'down' }],
      rail: c => c.props.activeLow ? '3V3' : 'GND',
      setRail(c, pin, r) { c.props.activeLow = r === '3V3'; },
      defaults: { color: 'red', activeLow: false },
      props: [
        { key: 'color', label: 'Color', type: 'select', options: opts(Object.keys(LED_COLORS)) },
        {
          key: 'activeLow', label: 'Wiring', type: 'select', bool: true, options: [
            ['false', 'Cathode → GND (on when HIGH)'],
            ['true', 'Anode → 3V3 (on when LOW)']
          ]
        }
      ],
      pinLabel(c, p) {
        const anode = (p.name === 'A') !== !!c.props.activeLow;
        return anode ? 'Anode (+)' : 'Cathode (−)';
      },
      render(c, o) {
        const col = LED_COLORS[c.props.color] || LED_COLORS.red;
        // Signal pin A is the anode when active-high, the cathode when active-low.
        // Like a real LED: the anode leg has a kink (the long leg), the cathode side of the rim is flat.
        const anodeLeft = !c.props.activeLow;
        const rightEnd = o && !o.auto ? 86 : 78;
        const leg = (x, end, anode) => {
          const k = x < 20 ? -3 : 3;
          return anode
            ? `<path d="M${x} 50 V58 l${k} 4 l${-k} 4 V${end}" class="leg"/>`
            : `<path d="M${x} 50 V${end}" class="leg"/>`;
        };
        const mark = (x, anode) =>
          `<text x="${x}" y="68" class="pol ${anode ? 'pol-a' : 'pol-k'}" text-anchor="middle">${anode ? '+' : '−'}</text>`;
        const rimX = anodeLeft ? 4 : 7;   // rim cut flush with the lens on the cathode side
        return `
          <circle class="glow" cx="20" cy="22" r="24" fill="${col}" opacity="0" filter="url(#glowBlur)"/>
          <path d="M14 46 V50 M26 46 V50" class="leg"/>
          ${leg(14, 86, anodeLeft)}
          ${leg(26, rightEnd, !anodeLeft)}
          ${mark(5, anodeLeft)}
          ${mark(35, !anodeLeft)}
          <path d="M7 48 V22 A13 13 0 0 1 33 22 V48 Z" fill="${col}" class="lens" opacity="0.35"/>
          <path d="M7 48 V22 A13 13 0 0 1 33 22 V48 Z" fill="url(#lensShine)" pointer-events="none"/>
          <rect x="${rimX}" y="44" width="29" height="6" rx="1.5" fill="${col}" opacity="0.55"/>
          <rect x="${rimX}" y="44" width="29" height="6" rx="1.5" fill="#000" opacity="0.25"/>
          <path d="M${anodeLeft ? 33 : 7} 43 V51" class="flat"/>
          ${o && !o.auto ? '' : supply(c.props.activeLow, 26, 78)}`;
      },
      update(el, c, ctx) {
        let d = ctx.duty('A');
        if (d === null || !ctx.powered) d = 0;
        else if (c.props.activeLow) d = ctx.driven('A') ? 1 - d : 0;
        const lens = el.querySelector('.lens');
        const glow = el.querySelector('.glow');
        lens.setAttribute('opacity', (0.32 + 0.68 * d).toFixed(3));
        glow.setAttribute('opacity', (0.85 * d).toFixed(3));
      }
    },

    button: {
      title: 'Push button',
      w: 60, h: 74,
      pins: [{ name: '1', label: 'Signal', x: 18, y: 74, dir: 'down' }],
      power: [{ name: 'P', label: 'Contact', x: 42, y: 74, dir: 'down' }],
      rail: c => c.props.mode === 'pulldown' ? '3V3' : 'GND',
      setRail(c, pin, r) { c.props.mode = r === '3V3' ? 'pulldown' : 'pullup'; },
      defaults: { color: 'red', mode: 'pullup', key: '' },
      props: [
        { key: 'color', label: 'Cap color', type: 'select', options: opts(Object.keys(CAP_COLORS)) },
        {
          key: 'mode', label: 'Wiring', type: 'select', options: [
            ['pullup', 'To GND: pressed = 0 (needs pull-up)'],
            ['pulldown', 'To 3V3: pressed = 1 (needs pull-down)']
          ]
        },
        { key: 'key', label: 'Keyboard key', type: 'key' }
      ],
      render(c, o) {
        const col = CAP_COLORS[c.props.color] || CAP_COLORS.red;
        return `
          <path d="M18 56 V74" class="leg"/>
          <path d="M42 56 V${o && !o.auto ? 74 : 66}" class="leg"/>
          ${supply(c.props.mode === 'pulldown', 42, 66, o)}
          <rect x="4" y="4" width="52" height="52" rx="4" fill="#3b3f47" stroke="#22252b" stroke-width="1.5"/>
          <circle cx="11" cy="11" r="3" fill="#1d1f24"/><circle cx="49" cy="11" r="3" fill="#1d1f24"/>
          <circle cx="11" cy="49" r="3" fill="#1d1f24"/><circle cx="49" cy="49" r="3" fill="#1d1f24"/>
          <g class="cap" data-press="1">
            <circle cx="30" cy="30" r="17" fill="#15171b"/>
            <circle class="cap-top" cx="30" cy="30" r="14" fill="${col}" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>
            <circle cx="26" cy="25" r="5" fill="#fff" opacity="0.18" pointer-events="none"/>
          </g>
          ${c.props.key ? `<text x="30" y="-4" class="keyhint" text-anchor="middle">[${esc(c.props.key === ' ' ? 'Space' : c.props.key)}]</text>` : ''}`;
      },
      update(el, c) {
        const top = el.querySelector('.cap-top');
        top.setAttribute('r', c.pressed ? 12.5 : 14);
        top.style.filter = c.pressed ? 'brightness(0.7)' : '';
      }
    },

    switch: {
      title: 'Slide switch',
      w: 70, h: 56,
      pins: [{ name: '1', label: 'Signal', x: 35, y: 56, dir: 'down' }],
      power: [
        { name: 'L', label: 'OFF contact', x: 14, y: 56, dir: 'down' },
        { name: 'R', label: 'ON contact', x: 56, y: 56, dir: 'down' }
      ],
      rail: (c, pin) => (pin === 'R') === (c.props.onLevel !== 'low') ? '3V3' : 'GND',
      setRail(c, pin, r) { c.props.onLevel = (pin === 'R') === (r === '3V3') ? 'high' : 'low'; },
      defaults: { on: false, onLevel: 'high' },
      props: [
        {
          key: 'onLevel', label: 'Wiring', type: 'select', options: [
            ['high', 'ON → 3V3, OFF → GND (on = 1)'],
            ['low', 'ON → GND, OFF → 3V3 (on = 0)']
          ]
        }
      ],
      // Logic level the switch drives onto its signal pin, or null if the selected
      // contact isn't wired to a supply (only possible when auto power is off).
      level(c, auto) {
        const side = c.props.on ? 'R' : 'L';
        if (!auto && (c.conn[side] === undefined || c.conn[side] === null)) return null;
        return this.rail(c, side) === '3V3' ? 1 : 0;
      },
      render(c, o) {
        const onHigh = c.props.onLevel !== 'low';
        const legEnd = o && !o.auto ? 56 : 44;
        return `
          <path d="M35 34 V56" class="leg"/>
          <path d="M14 34 V${legEnd}" class="leg"/><path d="M56 34 V${legEnd}" class="leg"/>
          ${supply(!onHigh, 14, 44, o)}
          ${supply(onHigh, 56, 44, o)}
          <g data-toggle="1" class="clickable">
            <rect x="2" y="6" width="66" height="28" rx="3" fill="#2f6fd6" stroke="#1d4f9e" stroke-width="1.5"/>
            <rect x="12" y="13" width="46" height="14" rx="2" fill="#1a2c4f"/>
            <rect class="knob" x="13" y="11" width="18" height="18" rx="2" fill="#e9edf3" stroke="#9aa3b2"/>
          </g>
          <text x="14" y="3" class="tiny" text-anchor="middle">OFF</text>
          <text x="56" y="3" class="tiny" text-anchor="middle">ON</text>`;
      },
      update(el, c) {
        el.querySelector('.knob').setAttribute('x', c.props.on ? 39 : 13);
      }
    },

    sevenseg: {
      title: '7-segment display',
      w: 84, h: 132,
      pins: [
        { name: 'g', label: 'Segment g', x: 12, y: 0, dir: 'up' },
        { name: 'f', label: 'Segment f', x: 26, y: 0, dir: 'up' },
        { name: 'a', label: 'Segment a', x: 58, y: 0, dir: 'up' },
        { name: 'b', label: 'Segment b', x: 72, y: 0, dir: 'up' },
        { name: 'e', label: 'Segment e', x: 12, y: 132, dir: 'down' },
        { name: 'd', label: 'Segment d', x: 26, y: 132, dir: 'down' },
        { name: 'c', label: 'Segment c', x: 58, y: 132, dir: 'down' },
        { name: 'dp', label: 'Decimal point', x: 72, y: 132, dir: 'down' }
      ],
      power: [
        { name: 'COM', label: 'Common (top)', x: 42, y: 0, dir: 'up' },
        { name: 'COM2', label: 'Common (bottom)', x: 42, y: 132, dir: 'down' }
      ],
      powerAny: true,
      rail: c => c.props.common === 'anode' ? '3V3' : 'GND',
      setRail(c, pin, r) { c.props.common = r === '3V3' ? 'anode' : 'cathode'; },
      defaults: { common: 'cathode', color: 'red' },
      props: [
        {
          key: 'common', label: 'Type', type: 'select', options: [
            ['cathode', 'Common cathode (segment on = HIGH)'],
            ['anode', 'Common anode (segment on = LOW)']
          ]
        },
        { key: 'color', label: 'Color', type: 'select', options: opts(['red', 'green', 'blue', 'yellow', 'orange', 'white']) }
      ],
      render(c, o) {
        const col = LED_COLORS[c.props.color] || LED_COLORS.red;
        const x0 = 24, y0 = 26, W = 34, H = 76, T = 7, L = H / 2;
        const hseg = (x, y) => `${x + 2},${y} ${x + T / 2 + 2},${y - T / 2} ${x + W - T / 2 - 2},${y - T / 2} ${x + W - 2},${y} ${x + W - T / 2 - 2},${y + T / 2} ${x + T / 2 + 2},${y + T / 2}`;
        const vseg = (x, y) => `${x},${y + 2} ${x + T / 2},${y + T / 2 + 2} ${x + T / 2},${y + L - T / 2 - 2} ${x},${y + L - 2} ${x - T / 2},${y + L - T / 2 - 2} ${x - T / 2},${y + T / 2 + 2}`;
        const sk = 'skewX(-6)';
        const segs = {
          a: hseg(x0, y0), g: hseg(x0, y0 + L), d: hseg(x0, y0 + H),
          f: vseg(x0, y0), b: vseg(x0 + W, y0), e: vseg(x0, y0 + L), c: vseg(x0 + W, y0 + L)
        };
        const pinLabels = this.pins.map(p =>
          `<text x="${p.x}" y="${p.y === 0 ? 16 : 122}" class="tiny light" text-anchor="middle">${p.name}</text>`).join('');
        return `
          ${this.pins.map(p => `<path d="M${p.x} ${p.y === 0 ? 8 : 124} V${p.y}" class="leg"/>`).join('')}
          <path d="M42 0 V8 M42 124 V132" class="leg"/>
          <rect x="0" y="8" width="84" height="116" rx="3" fill="#202226" stroke="#0e0f11" stroke-width="1.5"/>
          <rect x="6" y="18" width="72" height="96" rx="2" fill="#16171a"/>
          ${pinLabels}
          <text x="42" y="16" class="tiny light" text-anchor="middle">${c.props.common === 'anode' ? '+' : '−'}</text>
          ${o && !o.auto ? '' : `<text x="42" y="-3" class="tiny" text-anchor="middle">${c.props.common === 'anode' ? '3V3' : 'GND'}</text>`}
          ${supply(c.props.common === 'anode', 42, 133, o)}
          <g transform="translate(9 0) ${sk}" fill="${col}">
            ${Object.entries(segs).map(([k, pts]) => `<polygon class="seg seg-${k}" points="${pts}" opacity="0.1"/>`).join('')}
          </g>
          <circle class="seg seg-dp" cx="${x0 + W + 9}" cy="${y0 + H + 2}" r="3.6" fill="${col}" opacity="0.1"/>`;
      },
      update(el, c, ctx) {
        const anode = c.props.common === 'anode';
        for (const p of this.pins) {
          let d = ctx.duty(p.name);
          if (d === null || !ctx.powered) d = 0;
          else if (anode) d = ctx.driven(p.name) ? 1 - d : 0;
          const s = el.querySelector('.seg-' + p.name);
          s.setAttribute('opacity', (0.1 + 0.9 * d).toFixed(3));
          s.style.filter = d > 0.3 ? 'url(#segGlow)' : '';
        }
      }
    },

    // 8x8 LED matrix module(s) driven by MAX7219 chips (js/max7219.js); with 4 modules the
    // chips are daisy-chained left to right, the leftmost one is wired to the MCU.
    // Digit register n (0..7) lights row n from the top; data bit D7 is the leftmost column.
    matrix: {
      title: 'LED matrix (MAX7219)',
      w: 92, h: 124,
      size: c => ({ w: 8 + 84 * (+c.props.modules || 1), h: 124 }),
      pins: [
        { name: 'DIN', label: 'DIN (data in)', x: 46, y: 124, dir: 'down' },
        { name: 'CS', label: 'CS / LOAD', x: 64, y: 124, dir: 'down' },
        { name: 'CLK', label: 'CLK', x: 82, y: 124, dir: 'down' }
      ],
      power: [
        { name: 'VCC', label: 'VCC', x: 10, y: 124, dir: 'down' },
        { name: 'GND', label: 'GND', x: 28, y: 124, dir: 'down' }
      ],
      supplies: ['GND', '3V3', '5V'],
      rail: (c, pin) => pin === 'GND' ? 'GND' : c.props.vcc === '3V3' ? '3V3' : '5V',
      setRail(c, pin, r) { if (pin === 'VCC' && r !== 'GND') c.props.vcc = r; },
      defaults: { modules: '1', color: 'red', vcc: '5V' },
      props: [
        { key: 'modules', label: 'Modules', type: 'select', options: [['1', '1 (8×8)'], ['4', '4 chained (32×8)']] },
        { key: 'color', label: 'Color', type: 'select', options: opts(['red', 'green', 'blue', 'yellow', 'white']) }
      ],
      render(c, o) {
        const n = +c.props.modules || 1, col = LED_COLORS[c.props.color] || LED_COLORS.red;
        const { w } = this.size(c);
        let dots = '';
        for (let m = 0; m < n; m++) {
          const x0 = 4 + 84 * m;
          dots += `<rect x="${x0 + 2}" y="4" width="80" height="80" rx="2" fill="#101114"/>`;
          for (let r = 0; r < 8; r++) {
            for (let k = 0; k < 8; k++) dots += `<circle class="dot" cx="${x0 + 7 + k * 10}" cy="${9 + r * 10}" r="3.8" fill="${col}" opacity="0.12"/>`;
          }
        }
        const header = this.power.concat(this.pins).map(p => {
          const leg = !o || o.auto ? this.pins.includes(p) : true;
          return `${leg ? `<path d="M${p.x} 114 V124" class="leg"/>` : ''}
            <rect x="${p.x - 3}" y="110" width="6" height="6" fill="#c9a74a"/>
            <text x="${p.x}" y="106" class="tiny light" text-anchor="middle">${p.name}</text>`;
        }).join('');
        return `
          <rect x="0" y="0" width="${w}" height="116" rx="3" fill="#1d5b8f" stroke="#123a5c" stroke-width="1.5"/>
          ${dots}
          <text x="${w / 2}" y="94" class="tiny light" text-anchor="middle">MAX7219${n > 1 ? ' ×' + n : ''}</text>
          ${header}`;
      },
      update(el, c, ctx) {
        const chain = ctx.powered ? ctx.device : null;
        let key = '';
        const levels = [];
        const n = +c.props.modules || 1;
        for (let m = 0; m < n; m++) {
          const chip = chain && chain.chips[m];
          const rows = chip ? chip.rows() : null;
          const on = chip ? (0.35 + 0.65 * Math.sqrt(chip.brightness())).toFixed(2) : '0';
          for (let r = 0; r < 8; r++) {
            for (let k = 0; k < 8; k++) {
              const v = rows && (rows[r] >> (7 - k)) & 1 ? on : '0.12';
              levels.push(v);
              key += v;
            }
          }
        }
        if (el._dots === key) return;                // nothing changed since the last frame
        el._dots = key;
        el.querySelectorAll('.dot').forEach((d, i) => d.setAttribute('opacity', levels[i]));
      }
    }
  };

  root.PARTS = PARTS;
  root.LED_COLORS = LED_COLORS;
})(window);
