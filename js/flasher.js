/*
 * ESP32-C3 ROM serial bootloader client (the protocol esptool speaks), without a flasher stub.
 *
 * Works over any transport object that provides:
 *   write(Uint8Array) -> Promise
 *   setSignals({ dtr, rts }) -> Promise          (DTR/RTS drive GPIO9/EN on the boards)
 *   onData = callback(Uint8Array)                set by ESPLoader to receive bytes
 *   usbJtag                                      true for the chip's own USB-Serial-JTAG port
 * WebSerialTransport adapts the browser's Web Serial API to this interface.
 */
(function (root) {
  'use strict';

  const CMD = {
    FLASH_BEGIN: 0x02, FLASH_DATA: 0x03, FLASH_END: 0x04, MEM_BEGIN: 0x05, MEM_END: 0x06,
    MEM_DATA: 0x07, SYNC: 0x08, READ_REG: 0x0A, SPI_ATTACH: 0x0D
  };
  const CHIP_DETECT_MAGIC_REG = 0x40001000;
  const ESP32C3_MAGIC = [0x6921506F, 0x1B31506F, 0x4881606F, 0x4361606F];
  const RAM_BLOCK = 0x1800, FLASH_BLOCK = 0x400;
  const USB_JTAG_VID = 0x303A, USB_JTAG_PID = 0x1001;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const u32 = (...vals) => { const b = new Uint8Array(4 * vals.length), dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setUint32(4 * i, v >>> 0, true)); return b; };
  const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
  const checksum = data => { let c = 0xEF; for (const b of data) c ^= b; return c; };

  class ESPLoader {
    constructor(transport, log) {
      this.t = transport;
      this.log = log || (() => {});
      this.frames = [];          // decoded SLIP frames
      this.waiters = [];
      this.inFrame = false; this.esc = false; this.cur = [];
      this.passthrough = null;   // after the program starts: raw bytes go here instead
      transport.onData = bytes => this.feed(bytes);
    }

    // ---- SLIP
    feed(bytes) {
      if (this.passthrough) { this.passthrough(bytes); return; }
      for (const b of bytes) {
        if (b === 0xC0) {
          if (this.inFrame && this.cur.length) this.pushFrame(Uint8Array.from(this.cur));
          this.inFrame = true; this.cur = []; this.esc = false;
        } else if (!this.inFrame) {
          continue;                                     // boot messages between frames
        } else if (this.esc) {
          this.cur.push(b === 0xDC ? 0xC0 : b === 0xDD ? 0xDB : b); this.esc = false;
        } else if (b === 0xDB) {
          this.esc = true;
        } else {
          this.cur.push(b);
        }
      }
    }
    pushFrame(f) {
      const w = this.waiters.shift();
      if (w) w(f); else this.frames.push(f);
    }
    readFrame(timeout) {
      if (this.frames.length) return Promise.resolve(this.frames.shift());
      return new Promise((resolve, reject) => {
        const w = f => { clearTimeout(timer); resolve(f); };
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('Timed out waiting for the chip'));
        }, timeout);
        this.waiters.push(w);
      });
    }
    async writeFrame(pkt) {
      const out = [0xC0];
      for (const b of pkt) {
        if (b === 0xC0) out.push(0xDB, 0xDC);
        else if (b === 0xDB) out.push(0xDB, 0xDD);
        else out.push(b);
      }
      out.push(0xC0);
      await this.t.write(Uint8Array.from(out));
    }

    // ---- commands
    async command(op, data = new Uint8Array(0), chk = 0, timeout = 3000) {
      const hdr = new Uint8Array(8), dv = new DataView(hdr.buffer);
      hdr[0] = 0; hdr[1] = op; dv.setUint16(2, data.length, true); dv.setUint32(4, chk, true);
      await this.writeFrame(concat(hdr, data));
      const end = Date.now() + timeout;
      for (;;) {
        const f = await this.readFrame(Math.max(1, end - Date.now()));
        if (f.length < 8 || f[0] !== 1 || f[1] !== op) continue;   // stale reply (e.g. extra SYNC answers)
        const fdv = new DataView(f.buffer, f.byteOffset, f.byteLength);
        const value = fdv.getUint32(4, true), body = f.subarray(8);
        if (body.length >= 4 && body[body.length - 4] !== 0) {
          throw new Error(`Command 0x${op.toString(16)} failed (status ${body[body.length - 4]}, error 0x${body[body.length - 3].toString(16)})`);
        }
        return { value, body };
      }
    }

    async sync() {
      const data = concat(Uint8Array.from([0x07, 0x07, 0x12, 0x20]), new Uint8Array(32).fill(0x55));
      for (let i = 0; i < 8; i++) {
        try {
          await this.command(CMD.SYNC, data, 0, 150);
          await sleep(50);
          this.frames.length = 0;                      // the ROM answers a SYNC several times
          return;
        } catch (_) { /* retry */ }
      }
      throw new Error('No answer from the ROM bootloader');
    }

    async readReg(addr) { return (await this.command(CMD.READ_REG, u32(addr))).value >>> 0; }

    /** Put the chip into download mode and check that it is an ESP32-C3. */
    async connect() {
      for (let attempt = 0; attempt < 3; attempt++) {
        this.log(attempt ? 'Retrying…' : 'Resetting the board into download mode…');
        await this.resetToBootloader();
        try {
          await this.sync();
          break;
        } catch (e) {
          if (attempt === 2) throw new Error('Could not reach the ESP32-C3 ROM bootloader. Hold BOOT, press RESET, release BOOT, then try again.');
        }
      }
      const magic = await this.readReg(CHIP_DETECT_MAGIC_REG);
      if (!ESP32C3_MAGIC.includes(magic)) throw new Error(`This is not an ESP32-C3 (chip magic 0x${magic.toString(16)})`);
      this.log('Connected to ESP32-C3');
    }

    async resetToBootloader() {
      const s = (dtr, rts) => this.t.setSignals({ dtr, rts });
      if (this.t.usbJtag) {                            // USB-Serial-JTAG: the chip decodes DTR/RTS itself
        await s(false, false); await sleep(100);
        await s(true, false); await sleep(100);       // GPIO9 low
        await s(true, true);                          // reset while GPIO9 is still low: go through
        await s(false, true); await sleep(100);       // (1,1), not (0,0), as esptool does
        await s(false, false);
      } else {                                         // USB-UART bridge with the usual two transistors
        await s(false, true); await sleep(100);       // EN low
        await s(true, false); await sleep(50);        // EN high, GPIO9 low
        await s(false, false);
      }
      await sleep(200);
      this.frames.length = 0;
    }

    async hardReset() {
      await this.t.setSignals({ dtr: false, rts: true });
      await sleep(100);
      await this.t.setSignals({ dtr: false, rts: false });
    }

    /**
     * From now on hand every received byte to onOutput (the program's serial output).
     * skipReply drops the ROM's answer to the last command if it arrives first.
     */
    startMonitor(onOutput, skipReply) {
      let skipping = skipReply ? 0 : -1;               // 0: maybe a reply, 1: inside it, -1: done
      const deadline = Date.now() + 300;
      this.passthrough = bytes => {
        let i = 0;
        while (skipping >= 0 && i < bytes.length && Date.now() < deadline) {
          if (skipping === 0 && bytes[i] !== 0xC0) { skipping = -1; break; }
          if (bytes[i] === 0xC0 && skipping === 1) { skipping = -1; i++; break; }
          skipping = 1; i++;
        }
        if (i < bytes.length) onOutput(bytes.subarray(i));
      };
    }

    /** Load segments into RAM and jump to entry (lost on reset). Output then goes to onOutput. */
    async runInRam(segments, entry, progress, onOutput) {
      const total = segments.reduce((n, s) => n + s.data.length, 0);
      let done = 0;
      this.log(`Loading ${total} bytes into RAM…`);
      for (const s of segments) {
        const data = s.data;
        const blocks = Math.ceil(data.length / RAM_BLOCK);
        await this.command(CMD.MEM_BEGIN, u32(data.length, blocks, RAM_BLOCK, s.addr));
        for (let i = 0; i < blocks; i++) {
          const block = data.subarray(i * RAM_BLOCK, (i + 1) * RAM_BLOCK);
          await this.command(CMD.MEM_DATA, concat(u32(block.length, i, 0, 0), block), checksum(block));
          done += block.length;
          if (progress) progress(done / total, done, total);
        }
      }
      // The ROM answers and jumps to the program at once: don't wait for the reply.
      const hdr = new Uint8Array(8), body = u32(0, entry);
      hdr[1] = CMD.MEM_END; hdr[2] = body.length;
      this.log('Starting the program…');
      if (onOutput) this.startMonitor(onOutput, true);
      await this.writeFrame(concat(hdr, body));
    }

    /** Write an image to flash at offset and reset the chip to run it. Output then goes to onOutput. */
    async writeFlash(image, offset, progress, onOutput) {
      await this.command(CMD.SPI_ATTACH, new Uint8Array(8));
      const blocks = Math.ceil(image.length / FLASH_BLOCK);
      const eraseTimeout = 3000 + Math.ceil(image.length / 4096) * 300;
      this.log(`Erasing flash at 0x${offset.toString(16)} (${Math.ceil(image.length / 4096) * 4} KB)…`);
      await this.command(CMD.FLASH_BEGIN, u32(image.length, blocks, FLASH_BLOCK, offset, 0), 0, eraseTimeout);
      this.log(`Writing ${image.length} bytes…`);
      for (let i = 0; i < blocks; i++) {
        const block = new Uint8Array(FLASH_BLOCK).fill(0xFF);
        block.set(image.subarray(i * FLASH_BLOCK, (i + 1) * FLASH_BLOCK));
        await this.command(CMD.FLASH_DATA, concat(u32(block.length, i, 0, 0), block), checksum(block), 5000);
        if (progress) progress((i + 1) / blocks, Math.min((i + 1) * FLASH_BLOCK, image.length), image.length);
      }
      // No FLASH_END: the ROM loader rejects it here (esptool skips it too); a reset boots the image.
      if (onOutput) this.startMonitor(onOutput, false);
      this.log('Restarting the board…');
      await this.hardReset();
    }
  }

  /** Web Serial port -> transport. */
  class WebSerialTransport {
    constructor(port) {
      this.port = port;
      const info = port.getInfo ? port.getInfo() : {};
      this.usbJtag = info.usbVendorId === USB_JTAG_VID && info.usbProductId === USB_JTAG_PID;
      this.onData = null;
      this.reading = false;
    }
    async open(baudRate = 115200) {
      await this.port.open({ baudRate });
      this.reading = true;
      this.readLoop = (async () => {
        while (this.reading && this.port.readable) {
          this.reader = this.port.readable.getReader();
          try {
            for (;;) {
              const { value, done } = await this.reader.read();
              if (done) break;
              if (value && this.onData) this.onData(value);
            }
          } catch (_) {
            /* device reset or unplugged: try again while the port is readable */
          } finally {
            this.reader.releaseLock();
          }
          if (this.reading) await sleep(50);
        }
      })();
    }
    // A write can stall forever while the chip runs a program that doesn't read the USB port,
    // so give up after a while (the bytes stay queued and reach the ROM after the next reset).
    async write(bytes, timeout = 1000) {
      if (!this.writer) this.writer = this.port.writable.getWriter();
      let timer;
      try {
        await Promise.race([
          this.writer.write(bytes),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The board is not reading the serial port')), timeout); })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    setSignals({ dtr, rts }) { return this.port.setSignals({ dataTerminalReady: dtr, requestToSend: rts }); }
    async close() {
      this.reading = false;
      try { if (this.reader) await this.reader.cancel(); } catch (_) { /* ignore */ }
      try { if (this.writer) { await this.writer.abort(); this.writer.releaseLock(); } } catch (_) { /* ignore */ }
      try { await this.readLoop; } catch (_) { /* ignore */ }
      try { await this.port.close(); } catch (_) { /* ignore */ }
    }
  }

  const Flasher = { ESPLoader, WebSerialTransport, USB_JTAG_VID, USB_JTAG_PID };
  if (typeof module !== 'undefined' && module.exports) module.exports = Flasher;
  else root.Flasher = Flasher;
})(typeof window !== 'undefined' ? window : globalThis);
