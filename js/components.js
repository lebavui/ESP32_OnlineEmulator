/*
 * Peripheral parts that can be placed on the breadboard.
 *
 * Each part definition provides:
 *   w, h                 size of the part in world units
 *   pins                 signal pins that can be wired to a GPIO
 *   props                editable properties (shown in the inspector)
 *   render(c)            SVG markup (local coordinates)
 *   update(el, c, ctx)   refresh visuals; ctx.duty(pinName) -> 0..1 or null
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
  const opts = list => list.map(v => Array.isArray(v) ? v : [v, v[0].toUpperCase() + v.slice(1)]);

  const PARTS = {
    led: {
      title: 'LED',
      w: 40, h: 86,
      pins: [{ name: 'A', label: 'Anode (+)', x: 14, y: 86, dir: 'down' }],
      ground: { x: 26, y: 78, label: 'GND' },
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
      render(c) {
        const col = LED_COLORS[c.props.color] || LED_COLORS.red;
        return `
          <circle class="glow" cx="20" cy="22" r="24" fill="${col}" opacity="0" filter="url(#glowBlur)"/>
          <path d="M14 46 V86" class="leg"/>
          <path d="M26 46 V70 l0 8" class="leg"/>
          <path d="M7 48 V22 A13 13 0 0 1 33 22 V48 Z" fill="${col}" class="lens" opacity="0.35"/>
          <path d="M7 48 V22 A13 13 0 0 1 33 22 V48 Z" fill="url(#lensShine)" pointer-events="none"/>
          <rect x="4" y="44" width="32" height="6" rx="1.5" fill="${col}" opacity="0.55"/>
          <rect x="4" y="44" width="32" height="6" rx="1.5" fill="#000" opacity="0.25"/>
          <path d="M23 78 h6 M24 81 h4 M25 84 h2" class="gnd-sym"/>`;
      },
      update(el, c, ctx) {
        let d = ctx.duty('A');
        if (d === null) d = 0;
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
      ground: { x: 42, y: 66 },
      defaults: { color: 'red', mode: 'pullup', key: '' },
      props: [
        { key: 'color', label: 'Cap color', type: 'select', options: opts(Object.keys(CAP_COLORS)) },
        {
          key: 'mode', label: 'Wiring', type: 'select', options: [
            ['pullup', 'To GND, pull-up (pressed = 0)'],
            ['pulldown', 'To 3V3, pull-down (pressed = 1)']
          ]
        },
        { key: 'key', label: 'Keyboard key', type: 'key' }
      ],
      render(c) {
        const col = CAP_COLORS[c.props.color] || CAP_COLORS.red;
        const vcc = c.props.mode === 'pulldown';
        return `
          <path d="M18 56 V74" class="leg"/>
          <path d="M42 56 V66" class="leg"/>
          ${vcc ? '<text x="42" y="72" class="tiny" text-anchor="middle">3V3</text>' : '<path d="M39 66 h6 M40 69 h4 M41 72 h2" class="gnd-sym"/>'}
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
      defaults: { on: false },
      props: [],
      render() {
        return `
          <path d="M35 34 V56" class="leg"/>
          <path d="M14 34 V44" class="leg"/><path d="M56 34 V44" class="leg"/>
          <path d="M11 44 h6 M12 47 h4 M13 50 h2" class="gnd-sym"/>
          <text x="56" y="52" class="tiny" text-anchor="middle">3V3</text>
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
      render(c) {
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
          <g transform="translate(9 0) ${sk}" fill="${col}">
            ${Object.entries(segs).map(([k, pts]) => `<polygon class="seg seg-${k}" points="${pts}" opacity="0.1"/>`).join('')}
          </g>
          <circle class="seg seg-dp" cx="${x0 + W + 9}" cy="${y0 + H + 2}" r="3.6" fill="${col}" opacity="0.1"/>`;
      },
      update(el, c, ctx) {
        const anode = c.props.common === 'anode';
        for (const p of this.pins) {
          let d = ctx.duty(p.name);
          if (d === null) d = 0;
          else if (anode) d = ctx.driven(p.name) ? 1 - d : 0;
          const s = el.querySelector('.seg-' + p.name);
          s.setAttribute('opacity', (0.1 + 0.9 * d).toFixed(3));
          s.style.filter = d > 0.3 ? 'url(#segGlow)' : '';
        }
      }
    }
  };

  root.PARTS = PARTS;
  root.LED_COLORS = LED_COLORS;
})(window);
