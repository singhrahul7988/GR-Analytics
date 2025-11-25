import time
import pandas as pd
import os
import glob
import math
import numpy as np
import eventlet
from flask import Flask
from flask_socketio import SocketIO
from datetime import datetime

# Patch standard library so eventlet cooperates with sleeps and sockets
eventlet.monkey_patch()


# --- CONFIGURATION ---
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FILE_PATH_TELEMETRY = os.path.join(BASE_DIR, "data", "Barber", "telemetry_r1.csv")

# If not found at the expected location, search under the data directory for telemetry CSVs
if not os.path.exists(FILE_PATH_TELEMETRY):
    matches = glob.glob(os.path.join(BASE_DIR, "data", "**", "telemetry_*.csv"), recursive=True)
    if matches:
        FILE_PATH_TELEMETRY = matches[0]
    else:
        alt = os.path.join("data", "Barber", "telemetry_r1.csv")
        if os.path.exists(alt):
            FILE_PATH_TELEMETRY = alt

HERO_CAR_ID = "GR86-002-000"  # Ensure this ID exists in your CSV column

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

print("[GR] STARTING TOYOTA GR STRATEGY SERVER...")

# --- GLOBAL STATE ---
telemetry_data = None
track_shape = []  # Stores the static map line
gps_bounds = {"min_lat": 0, "max_lat": 0, "min_long": 0, "max_long": 0}
start_point = None
lap_by_timestamp = {}
lap_start_value = 1
total_laps = None
weather_rows = []
_weather_idx = 0
last_weather_sent = None
session_best_lap = None
lap_durations = []


# --- HELPERS ---
def safe_float(value, default=0.0):
    try:
        f = float(value)
        if math.isnan(f):
            return default
        return f
    except Exception:
        return default


def safe_int(value, default=0):
    try:
        f = safe_float(value, default)
        return int(f)
    except Exception:
        return default


def build_sim_packet(weather=None):
    t = time.time()
    return {
        "timestamp": datetime.now().strftime("%H:%M:%S"),
        "speed": 140 + 40 * math.sin(t),
        "rpm": 5000 + 1500 * math.sin(t),
        "gear": 4,
        "throttle": 80,
        "brake": 0,
        "g_lat": math.sin(t),
        "g_long": math.cos(t),
        "lat": 33.532,
        "long": -86.619,
        "tire_health": 98.5,
        "lap": 1,
        "weather": weather
        or {
            "temp_c": 28.0,
            "track_temp_c": 32.0,
            "humidity": 55,
            "wind_kph": 8,
            "wind_dir": 0,
            "rain": 0,
        },
    }


def distance_m(lat1, lon1, lat2, lon2):
    """Approximate haversine distance in meters."""
    r = 6371000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# --- 1. DATA LOADING & PROCESSING ---
try:
    if os.path.exists(FILE_PATH_TELEMETRY):
        print(f"   Loading telemetry: {FILE_PATH_TELEMETRY}")

        # Load data (Adjust nrows for full race)
        raw_df = pd.read_csv(FILE_PATH_TELEMETRY, nrows=50000)

        # 1.1 Filter for ONE Car (Crucial for clean data)
        if "vehicle_id" in raw_df.columns:
            cars = raw_df["vehicle_id"].unique()
            print(f"   Found cars: {cars}")
            target_car = HERO_CAR_ID if HERO_CAR_ID in cars else cars[0]
            print(f"   Focusing on car: {target_car}")
            raw_df = raw_df[raw_df["vehicle_id"] == target_car]

        print("   Pivoting data (long -> wide)...")
        telemetry_data = (
            raw_df.pivot_table(
                index="timestamp",
                columns="telemetry_name",
                values="telemetry_value",
                aggfunc="first",
            )
            .reset_index()
            .sort_values("timestamp")
        )

        # Lap metadata (needs to exist before we carve the map)
        if "lap" in raw_df.columns:
            lap_by_timestamp = raw_df.groupby("timestamp")["lap"].first().to_dict()
            telemetry_data["lap_value"] = telemetry_data["timestamp"].map(lap_by_timestamp)
            total_laps = int(raw_df["lap"].max())
            # Start from the first lap present in the dataset
            lap_start_value = max(1, int(pd.Series(lap_by_timestamp.values()).dropna().min()))
        else:
            total_laps = None

        # Forward-fill key channels to avoid gaps during pivot playback
        for col in ["speed", "Speed", "SPEED", "nmot", "RPM", "gear", "Gear", "Throttle", "aps", "Brake", "brake_pressure", "accx_can", "lat_g", "accy_can", "long_g"]:
            if col in telemetry_data.columns:
                telemetry_data[col] = telemetry_data[col].ffill().bfill()

        # 1.2 Pre-Calculate Track Shape (The "Perfect Map")
        print("   Generating track map...")
        lat_col = "VBOX_Lat_Min" if "VBOX_Lat_Min" in telemetry_data.columns else "GPS_Lat"
        long_col = "VBOX_Long_Minutes" if "VBOX_Long_Minutes" in telemetry_data.columns else "GPS_Long"
        if lat_col not in telemetry_data.columns or long_col not in telemetry_data.columns:
            lat_col = None
            long_col = None

        if lat_col and long_col:
            telemetry_data[lat_col] = telemetry_data[lat_col].ffill()
            telemetry_data[long_col] = telemetry_data[long_col].ffill()

            gps_bounds["min_lat"] = telemetry_data[lat_col].min()
            gps_bounds["max_lat"] = telemetry_data[lat_col].max()
            gps_bounds["min_long"] = telemetry_data[long_col].min()
            gps_bounds["max_long"] = telemetry_data[long_col].max()

            # Build the map from the densest lap to avoid cross-lap chords
            track_source = telemetry_data
            if "lap_value" in telemetry_data.columns:
                lap_counts = telemetry_data["lap_value"].value_counts().sort_values(ascending=False)
                best_lap = lap_counts.index[0] if not lap_counts.empty else None
                if best_lap is not None:
                    lap_slice = telemetry_data[telemetry_data["lap_value"] == best_lap]
                    if len(lap_slice) > 10:
                        track_source = lap_slice

            track_df = track_source.iloc[::3][[lat_col, long_col]].dropna().drop_duplicates()
            for _, row in track_df.iterrows():
                track_shape.append({"lat": float(row[lat_col]), "long": float(row[long_col])})
            # Fallback to full dataset if lap selection was too short
            if len(track_shape) < 30:
                track_shape.clear()
                full_df = telemetry_data.iloc[::5][[lat_col, long_col]].dropna().drop_duplicates()
                for _, row in full_df.iterrows():
                    track_shape.append({"lat": float(row[lat_col]), "long": float(row[long_col])})
            if track_shape:
                start_point = track_shape[0]
        if not start_point:
            start_point = {"lat": 33.532, "long": -86.619}

        print(f"   Data ready: {len(telemetry_data)} ticks. Map points: {len(track_shape)}")
        print(f"   Sensors: {list(telemetry_data.columns)}")

    else:
        print("   Telemetry file not found. Swapping to simulation mode.")

    print(f"   Resolved telemetry path: {FILE_PATH_TELEMETRY}")
    try:
        print(f"   SocketIO async mode: {socketio.async_mode}")
    except Exception:
        pass

    # Load weather if present
    weather_path = os.path.join(BASE_DIR, "data", "Barber", "weather_r1.CSV")
    if os.path.exists(weather_path):
        try:
            wdf = pd.read_csv(weather_path, sep=";")
            weather_rows = [
                {
                    "temp_c": safe_float(row.get("AIR_TEMP"), 28.0),
                    "track_temp_c": safe_float(row.get("TRACK_TEMP"), 32.0),
                    "humidity": safe_int(row.get("HUMIDITY"), 55),
                    "wind_kph": safe_float(row.get("WIND_SPEED"), 8.0),
                    "wind_dir": safe_float(row.get("WIND_DIRECTION"), 0.0),
                    "rain": safe_int(row.get("RAIN"), 0),
                }
                for _, row in wdf.iterrows()
            ]
            if weather_rows:
                print(f"   Weather rows loaded: {len(weather_rows)}")
        except Exception as e:
            print(f"   Weather file load failed: {e}")
    if total_laps is None:
        # fallback so UI shows something
        total_laps = 22
    else:
        total_laps = max(total_laps, 22)

except Exception as e:
    print(f"   Error processing CSV: {e}")


# --- 2. REPLAY ENGINE ---
def run_race():
    print("   Race session started")
    global session_best_lap, lap_durations
    index = 0
    tire_health = 100.0
    # Keep separate virtual tires for visualization
    tires = {
        "fl": 100.0,
        "fr": 100.0,
        "rl": 100.0,
        "rr": 100.0,
    }
    current_lap = lap_start_value or 1
    sim_lap_start = time.time()
    last_speed = 0.0
    last_rpm = 0.0
    last_cross_time = 0.0
    prev_cross_time = None
    last_lap_duration = None
    session_best_speed = 0.0
    near_start = False
    weather_snapshot = weather_rows[_weather_idx % len(weather_rows)] if weather_rows else None

    while True:
        lap_finished = False
        lap_crossed = False
        reached_end = False
        if telemetry_data is not None and index < len(telemetry_data):
            row = telemetry_data.iloc[index]

            raw_speed = safe_float(
                row.get(
                    "speed",
                    row.get("Speed", row.get("SPEED", row.get("speed_kmh", row.get("speed_mps", 0)))),
                )
            )
            rpm_hint = safe_float(row.get("RPM", row.get("nmot", 0)))
            if raw_speed <= 0 and last_speed > 5:
                raw_speed = last_speed
            if raw_speed <= 0 and rpm_hint > 500:
                raw_speed = max(8.0, rpm_hint / 80.0)
            speed = raw_speed if last_speed <= 0 else (0.97 * raw_speed + 0.03 * last_speed)
            brake = safe_float(row.get("Brake", row.get("brake_pressure", 0)))
            acc_x = safe_float(row.get("accx_can", row.get("lat_g", 0)))
            acc_y = safe_float(row.get("accy_can", row.get("long_g", 0)))

            # Virtual per-tire model: more wear on the loaded side under lateral G, all under braking
            brake_load = brake * 0.01
            corner_load = abs(acc_x) * 0.02
            if acc_x >= 0:
                tires["fl"] = max(0, tires["fl"] - corner_load)
                tires["rl"] = max(0, tires["rl"] - corner_load * 0.9)
            else:
                tires["fr"] = max(0, tires["fr"] - corner_load)
                tires["rr"] = max(0, tires["rr"] - corner_load * 0.9)
            for key in tires:
                tires[key] = max(0, tires[key] - brake_load * 0.25)
            tire_health = round(sum(tires.values()) / 4.0, 2)

            last_speed = max(speed, 0.0)
            raw_rpm = safe_float(row.get("RPM", row.get("nmot", 0)))
            if raw_rpm <= 100 and last_rpm > 0:
                raw_rpm = last_rpm
            rpm_val = raw_rpm if last_rpm <= 0 else (0.95 * raw_rpm + 0.05 * last_rpm)
            last_rpm = max(rpm_val, 0.0)

            lat_val = 33.532
            long_val = -86.619
            if "VBOX_Lat_Min" in row:
                lat_val = safe_float(row.get("VBOX_Lat_Min"), lat_val)
            elif "GPS_Lat" in row:
                lat_val = safe_float(row.get("GPS_Lat"), lat_val)
            if "VBOX_Long_Minutes" in row:
                long_val = safe_float(row.get("VBOX_Long_Minutes"), long_val)
            elif "GPS_Long" in row:
                long_val = safe_float(row.get("GPS_Long"), long_val)

            packet = {
                "timestamp": str(row.get("timestamp")),
                "speed": speed,
                "rpm": rpm_val,
                "gear": safe_int(row.get("Gear", row.get("gear", 0))),
                "throttle": safe_float(row.get("Throttle", row.get("aps", 0))),
                "brake": brake,
                "g_lat": acc_x,
                "g_long": acc_y,
                "lat": lat_val,
                "long": long_val,
                "tire_health": tire_health,
                "tire_healths": tires.copy(),
                "lap": current_lap,
                "total_laps": total_laps,
                "weather": weather_snapshot,
            }
            index += 1
            if index >= len(telemetry_data):
                reached_end = True
        else:
            packet = build_sim_packet()
            # Apply same virtual wear model to sim packet
            brake = packet["brake"]
            acc_x = packet["g_lat"]
            brake_load = brake * 0.01
            corner_load = abs(acc_x) * 0.02
            if acc_x >= 0:
                tires["fl"] = max(0, tires["fl"] - corner_load)
                tires["rl"] = max(0, tires["rl"] - corner_load * 0.9)
            else:
                tires["fr"] = max(0, tires["fr"] - corner_load)
                tires["rr"] = max(0, tires["rr"] - corner_load * 0.9)
            for key in tires:
                tires[key] = max(0, tires[key] - brake_load * 0.25)
            tire_health = round(sum(tires.values()) / 4.0, 2)
            packet["tire_health"] = tire_health
            packet["tire_healths"] = tires.copy()
            packet["lap"] = current_lap
            packet["total_laps"] = total_laps
            packet["weather"] = weather_snapshot
            # simple sim lap timer: assume 90s lap and increment when elapsed
            if time.time() - sim_lap_start > 90:
                lap_finished = True
                sim_lap_start = time.time()
        if weather_rows:
            globals()["_weather_idx"] = (_weather_idx + 1) % len(weather_rows)
            weather_snapshot = weather_rows[_weather_idx]

        # Lap crossing detection around start/finish
        if start_point and "lat" in packet and "long" in packet:
            dist = distance_m(packet["lat"], packet["long"], start_point["lat"], start_point["long"])
            now = time.time()
            if dist < 15 and not near_start and now - last_cross_time > 5:
                lap_crossed = True
                prev_cross_time = last_cross_time if last_cross_time else None
                last_cross_time = now
                near_start = True
            elif dist > 25:
                near_start = False
        lap_duration_this = last_cross_time - prev_cross_time if lap_crossed and prev_cross_time else None

        # Derive high-level alerts and suggestions
        alerts = []
        new_top_speed = False
        if packet["speed"] > session_best_speed + 0.5:
            session_best_speed = packet["speed"]
            new_top_speed = True

        # Braking / throttle discipline
        if packet["brake"] > 85 and packet["speed"] > 80:
            alerts.append({"msg": "Heavy braking sustained; lift sooner to save brakes.", "type": "warn"})
        if packet["brake"] > 30 and packet["throttle"] > 20:
            alerts.append({"msg": "Separate brake and throttle to reduce scrub.", "type": "info"})

        # Cornering balance
        if abs(packet["g_lat"]) > 1.2 and packet["speed"] < 90:
            alerts.append({"msg": "Carry more mid-corner speed; open steering earlier.", "type": "info"})
        if abs(packet["g_lat"]) > 1.6 and packet["throttle"] > 40:
            alerts.append({"msg": "Ease throttle to prevent over-rotation.", "type": "warn"})
        if abs(packet["g_lat"]) > 1.8:
            alerts.append({"msg": "Peak lateral load; unwind steering sooner.", "type": "warn"})

        # Entry/exit pacing
        if packet["speed"] > 150 and packet["brake"] > 20 and packet["speed"] < 110:
            alerts.append({"msg": "Brake a touch later; entry speed leaving time on table.", "type": "info"})
        if packet["throttle"] < 35 and packet["brake"] < 5 and (last_speed - packet["speed"]) > 8:
            alerts.append({"msg": "Feed throttle earlier on exit to recover speed.", "type": "info"})

        # Powertrain / shifting
        if packet["rpm"] > 7200:
            alerts.append({"msg": "High RPM; upshift sooner to protect engine.", "type": "warn"})
        if packet.get("tire_health", 100) < 85 and packet["rpm"] > 6500:
            alerts.append({"msg": "Short-shift to reduce tire slip.", "type": "info"})

        # Tire & brake balance
        if packet.get("tire_health", 100) < 90:
            alerts.append({"msg": "Tire wear emerging – manage inputs.", "type": "info"})
        fronts = rears = None
        if packet.get("tire_healths"):
            fronts = (packet["tire_healths"].get("fl", 100) + packet["tire_healths"].get("fr", 100)) / 2
            rears = (packet["tire_healths"].get("rl", 100) + packet["tire_healths"].get("rr", 100)) / 2
        if packet["brake"] > 80 and fronts is not None and rears is not None and (fronts + 5) < rears:
            alerts.append({"msg": "Fronts wearing faster; release brake earlier or bias rearward.", "type": "warn"})

        # Weather/environment
        if packet.get("weather"):
            if packet["weather"].get("track_temp_c", 0) > 40 and packet.get("tire_health", 100) < 80:
                alerts.append({"msg": "Hot track; back off 5% entry to save tires.", "type": "info"})
            if packet["weather"].get("rain", 0) > 0:
                alerts.append({"msg": "Rain detected; extend brake zones and smooth throttle.", "type": "warn"})
            if packet["weather"].get("wind_kph", 0) > 15:
                alerts.append({"msg": "High wind; expect aero loss in fast corners.", "type": "info"})

        # Lap timing
        if lap_duration_this:
            alerts.append({"msg": f"Lap {current_lap} complete in {lap_duration_this:.1f}s", "type": "success"})
            lap_durations.append(lap_duration_this)
            if session_best_lap is None or lap_duration_this < session_best_lap:
                session_best_lap = lap_duration_this
            elif session_best_lap and lap_duration_this > session_best_lap + 1.0:
                delta = lap_duration_this - session_best_lap
                alerts.append({"msg": f"Off best by {delta:.1f}s; focus on earlier throttle at exit.", "type": "info"})
            if len(lap_durations) >= 3:
                recent = lap_durations[-3:]
                if max(recent) - min(recent) > 0.8:
                    alerts.append({"msg": "Lap variance high; stabilize braking points.", "type": "info"})

        if new_top_speed and packet["speed"] > 120:
            alerts.append({"msg": f"New top speed {packet['speed']:.1f} km/h", "type": "success"})

        # Simple coaching tip based on current state
        tip = None
        if packet["brake"] > 50 and packet["throttle"] > 30:
            tip = "Blend off brake before throttle to reduce tire scrub."
        elif abs(packet["g_lat"]) > 1.2 and packet["speed"] < 80:
            tip = "Carry a touch more mid-corner speed; open steering sooner."
        elif packet.get("tire_health", 100) < 85:
            tip = "Back off 5% entry speed to save fronts for the stint."
        elif lap_finished and not lap_duration_this:
            tip = f"Lap {current_lap} complete. Compare sector deltas."
        if tip:
            alerts.append({"msg": tip, "type": "info"})
        if not alerts:
            alerts.append({"msg": "Pace steady. Look for brake markers.", "type": "info"})
        packet["alerts"] = alerts
        packet["coaching_tip"] = tip

        lap_finished = lap_crossed or reached_end
        if lap_finished:
            current_lap += 1
            if lap_duration_this:
                last_lap_duration = lap_duration_this
            if telemetry_data is not None and reached_end:
                index = 0

        # Weather damping: only update if temperature changes >= 1 deg
        global last_weather_sent
        if weather_snapshot and last_weather_sent:
            if (
                abs(weather_snapshot["temp_c"] - last_weather_sent.get("temp_c", weather_snapshot["temp_c"]))
                < 1
                and abs(
                    weather_snapshot["track_temp_c"] - last_weather_sent.get("track_temp_c", weather_snapshot["track_temp_c"])
                )
                < 1
            ):
                packet["weather"] = last_weather_sent
            else:
                last_weather_sent = weather_snapshot
        elif weather_snapshot:
            last_weather_sent = weather_snapshot
        packet["weather"] = packet.get("weather") or last_weather_sent

        socketio.emit("telemetry_update", packet)
        socketio.sleep(0.1)  # Slow to 10Hz to reduce flickering and smooth motion


@socketio.on("connect")
def handle_connect():
    print("   Dashboard connected")
    socketio.emit("track_init", {"shape": track_shape, "bounds": gps_bounds, "start": start_point})
    socketio.start_background_task(run_race)


 #if __name__ == "__main__":
   # socketio.run(app, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True) 

if __name__ == "__main__":
    # Get the PORT from environment variables (Render sets this)
    port = int(os.environ.get("PORT", 5000))
    # Remove 'allow_unsafe_werkzeug' for production if possible, but it's okay for hackathons
    socketio.run(app, host="0.0.0.0", port=port)

