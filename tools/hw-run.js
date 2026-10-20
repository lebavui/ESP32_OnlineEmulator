// node tools/hw-run.js <ram|flash> <example-id | file.S> [seconds] [text to send]
// Needs tools/hw-bridge.py running: python tools/hw-bridge.py COM11
const net = require('net'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js') + path.sep;
const RVAsm = require(R + 'assembler.js'), F = require(R + 'firmware.js'), { ESPLoader } = require(R + 'flasher.js');
const { EXAMPLES } = require(R + 'examples.js');
const [mode, what, secs = '8', input] = process.argv.slice(2);
const src = fs.existsSync(what) ? fs.readFileSync(what, 'utf8') : EXAMPLES.find(e => e.id === what).code;
const prog = RVAsm.assemble(src);
if (!prog.ok) { console.log(prog.errors); process.exit(1); }
const fw = F.buildFirmware(prog);
const sock = net.connect(5555, '127.0.0.1');
const frame = (t, p) => { const h = Buffer.from([t, p.length & 255, p.length >> 8]); sock.write(Buffer.concat([h, Buffer.from(p)])); };
const transport = {
  usbJtag: true, onData: null,
  write: async b => frame(0, b),
  setSignals: async ({ dtr, rts }) => frame(1, [dtr ? 1 : 0, rts ? 1 : 0])
};
sock.on('data', d => transport.onData && transport.onData(new Uint8Array(d)));
sock.on('connect', async () => {
  const ld = new ESPLoader(transport, m => console.log('[loader]', m));
  let out = '';
  try {
    await ld.connect();
    const t0 = Date.now();
    const onOut = b => { out += Buffer.from(b).toString('latin1'); };
    if (mode === 'ram') await ld.runInRam(fw.segments, fw.entry, null, onOut);
    else await ld.writeFlash(fw.image, 0, p => { if (p === 1) console.log('[loader] written', fw.image.length, 'bytes'); }, onOut);
    console.log('[loader] started in', Date.now() - t0, 'ms');
  } catch (e) { console.log('ERROR', e.message); sock.destroy(); return; }
  if (input) setTimeout(() => transport.write(Buffer.from(input.replace(/\\n/g, '\n'))), 1000);
  setTimeout(() => { console.log('---- output ----\n' + out + '\n---- end ----'); sock.destroy(); }, +secs * 1000);
});
