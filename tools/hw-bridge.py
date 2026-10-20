# TCP <-> serial bridge so tools/hw-run.js (Node) can drive a real board with js/flasher.js.
# Usage: python tools/hw-bridge.py <serial port, e.g. COM11 or /dev/ttyACM0> [tcp port, default 5555]
# Client frames: [type u8][len u16 LE][payload]; type 0 = data, 1 = signals [dtr, rts]. Server -> client: raw bytes.
import socket, sys, threading, serial
port = sys.argv[1]; tcp = int(sys.argv[2]) if len(sys.argv) > 2 else 5555
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', tcp)); srv.listen(1)
print('listening', tcp, flush=True)
while True:
    conn, _ = srv.accept()
    ser = serial.Serial(port, 115200, timeout=0.02)
    alive = [True]
    def pump():
        while alive[0]:
            try:
                d = ser.read(4096)
            except Exception as e:
                print('serial read error', e, flush=True); break
            if d:
                try: conn.sendall(d)
                except Exception: break
    th = threading.Thread(target=pump, daemon=True); th.start()
    buf = b''
    try:
        while True:
            d = conn.recv(65536)
            if not d: break
            buf += d
            while len(buf) >= 3:
                t, n = buf[0], buf[1] | (buf[2] << 8)
                if len(buf) < 3 + n: break
                p = buf[3:3 + n]; buf = buf[3 + n:]
                if t == 0: ser.write(p)
                else:
                    ser.rts = bool(p[1]); ser.dtr = bool(p[0]); ser.rts = bool(p[1])
    except Exception as e:
        print('conn error', e, flush=True)
    alive[0] = False; th.join(); ser.close(); conn.close()
    print('client closed', flush=True)
