TOYOTA GR Live Telemetry Dashboard
==================================

What this is
------------
- Real-time race dashboard built for the Toyota GR challenge.
- Python/Flask + Socket.IO server replays the provided telemetry CSV (or simulates data if the CSV is missing).
- React + Vite client renders the live map, speed/RPM traces, tire wear model, weather feed, and driving cues.

Project layout
--------------
- `server/server.py` – streams telemetry ticks and weather snapshots over Socket.IO (10 Hz). Falls back to a synthetic feed if the CSV at `data/Barber/telemetry_r1.csv` is not found.
- `server/requirements.txt` – Python deps: Flask, Flask-SocketIO, Pandas, NumPy, Eventlet, etc.
- `client/` – React dashboard (Vite). Connects to the backend via `VITE_SOCKET_URL` (defaults to `http://localhost:5000`).
- `data/Barber/` – sample telemetry + weather files used for local replay.

Run it locally (two terminals)
------------------------------
Prereqs: Python 3.10+ and Node.js 18+ with npm.

1) Backend
- `cd server`
- (optional) `python -m venv .venv && .venv\\Scripts\\activate`  # or `source .venv/bin/activate` on macOS/Linux
- `pip install -r requirements.txt`
- `python server.py`  # listens on `PORT` env or 5000

2) Frontend
- open a second terminal
- `cd client`
- `npm install`
- `npm run dev`
- Vite will print a local URL (usually `http://localhost:5173`). The client will reach the backend at `http://localhost:5000` unless you set `VITE_SOCKET_URL`.

Notes for judges/demos
----------------------
- If you keep the provided CSVs in `data/Barber/`, the dashboard replays real laps; otherwise it auto-switches to a smooth simulated feed.
- Weather overlays come from `data/Barber/weather_r1.CSV` when present.
- To point the client at a remote server, run `VITE_SOCKET_URL=http://<server-host>:5000 npm run dev` (or set it in a `.env` file).
- Both apps are lightweight and should run fine on a standard laptop; no external services required.
