import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis, XAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { AlertTriangle, Zap, Disc, Thermometer } from 'lucide-react';
import { io } from 'socket.io-client';

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [trackData, setTrackData] = useState({ shape: [], bounds: null });
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState("CONNECTING...");
  const [displayTime, setDisplayTime] = useState("");
  const [persistentAlerts, setPersistentAlerts] = useState([]);  // Alerts persist unless explicitly cleared
  const [displayEngine, setDisplayEngine] = useState({ speed: 0, rpm: 0 });
  const [carPos, setCarPos] = useState({ x: 50, y: 50 });
  const [gVector, setGVector] = useState({ x: 0, y: 0 });
  const [sessionInsights, setSessionInsights] = useState(null);
  const lastSpeedRef = useRef(0);
  const lastRpmRef = useRef(0);
  const lastWeatherRef = useRef(null);
  const alertIdRef = useRef(0);
  const lastAlertKeyRef = useRef(null);
  const gMagnitude = Math.sqrt(gVector.x * gVector.x + gVector.y * gVector.y);
  const trackLabels = [
    { label: 'S1', x: 64.5, y: 17, bg: '#2563eb' },
    { label: 'S2', x: 82, y: 30, bg: '#ca8a04' },
    { label: 'S3', x: 23, y: 80, bg: '#dc2626' },
    { label: 'P1', x: 44, y: 48 },
    { label: 'P2', x: 58, y: 28 },
    { label: 'T1', x: 55, y: 52 },
    { label: 'T3', x: 50, y: 62 },
    { label: 'T4', x: 42, y: 80 },
    { label: 'P5', x: 28, y: 67 },
  ];

  // Sector boundaries for clear start/end markers on the map
  const trackSectors = [
    // S1: start near P1/T1, end at the top of the loop
    { name: 'S1', color: '#2563eb', start: { x: 49, y: 47 }, end: { x: 58, y: 12 } },
    // S2: start from inner hairpin exit, end along right-hand straight
    { name: 'S2', color: '#ca8a04', start: { x: 53, y: 57 }, end: { x: 84, y: 32 } },
    // S3: start near T4 entry, end entering final loop
    { name: 'S3', color: '#dc2626', start: { x: 41, y: 70 }, end: { x: 22, y: 85 } },
  ];

  const clamp = (val, min, max) => Math.min(max, Math.max(min, val));
  const smoothValue = (current, target, factor = 0.28, snap = 0.4) => {
    if (!Number.isFinite(target)) return current;
    const next = current + (target - current) * factor;
    return Math.abs(next - target) < snap ? target : next;
  };

  useEffect(() => {
      const socketUrl = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';
      // Connect to Python Backend (explicit transports + reconnection settings for diagnostics)
      const socket = io(socketUrl, {
         transports: ['websocket', 'polling'],
         reconnectionAttempts: 5,
         reconnectionDelay: 1000,
         timeout: 5000
      });

    socket.on('connect', () => {
      setStatus("ONLINE");
      console.log("[socket] Connected to Python Server");
    });

      socket.on('disconnect', () => setStatus("OFFLINE"));

      // Helpful diagnostics listeners for connection issues
      socket.on('connect_error', (err) => {
         console.error('Socket connect_error:', err);
         setStatus(`ERROR: ${err && err.message ? err.message : 'connect_error'}`);
      });

      socket.on('connect_timeout', () => {
         console.warn('Socket connect_timeout');
         setStatus('TIMEOUT');
      });

    // 1. Receive the Pre-Calculated Track Map (One time on load)
    socket.on('track_init', (initData) => {
      console.log("[socket] Track Map Received:", initData.shape.length, "points");
      setTrackData(initData);
    });

    // Session-level insights (lap/sector stats)
    socket.on('session_insights', (payload) => {
      setSessionInsights(payload);
    });

    // 2. Receive Live Telemetry Stream
    socket.on('telemetry_update', (packet) => {
      // Preserve the CSV-fed values but keep the UI calm
      const incomingSpeed = Number(packet.speed);
      const cleanSpeed = Number.isFinite(incomingSpeed) ? incomingSpeed : lastSpeedRef.current || 0;
      lastSpeedRef.current = cleanSpeed;

      const incomingRpm = Number(packet.rpm);
      const cleanRpm = Number.isFinite(incomingRpm) ? incomingRpm : lastRpmRef.current || 0;
      lastRpmRef.current = cleanRpm;

      // weather damping on client too: only update if temp moves by >=1
      let weatherState = packet.weather;
      if (packet.weather && lastWeatherRef.current) {
        const d1 = Math.abs(packet.weather.temp_c - (lastWeatherRef.current.temp_c || packet.weather.temp_c));
        const d2 = Math.abs(packet.weather.track_temp_c - (lastWeatherRef.current.track_temp_c || packet.weather.track_temp_c));
        if (d1 < 1 && d2 < 1) {
          weatherState = lastWeatherRef.current;
        } else {
          lastWeatherRef.current = packet.weather;
        }
      } else if (packet.weather) {
        lastWeatherRef.current = packet.weather;
      }

      setData({ ...packet, speed: cleanSpeed, rpm: cleanRpm, weather: weatherState });

      // Smooth display-only values without losing the real numbs welers
      setDisplayEngine(prev => {
        const baseSpeed = prev.speed === 0 ? cleanSpeed : prev.speed;
        const baseRpm = prev.rpm === 0 ? cleanRpm : prev.rpm;
        return {
          speed: smoothValue(baseSpeed, cleanSpeed, 0.22, 0.3),
          rpm: smoothValue(baseRpm, cleanRpm, 0.18, 5),
        };
      });

      // Throttle UTC time updates to the second to avoid flicker
      const tsRaw = (packet.timestamp || "").toString();
      const tsSecond = tsRaw.includes(".") ? tsRaw.split(".")[0] : tsRaw;
      setDisplayTime(prev => (prev === tsSecond ? prev : tsSecond));
      
      // Persistent alerts: accumulate new ones, keep only last 8, latest first
      setPersistentAlerts(prev => {
        const incoming = Array.isArray(packet.alerts) ? packet.alerts : [];
        const existingKeys = new Set(prev.map(a => a.key || `${a.msg}-${a.type}`));
        let next = [...prev];

        incoming.forEach(alert => {
          if (!alert || !alert.msg || !alert.type) return;
          const key = `${alert.type}-${alert.msg}`;
          if (existingKeys.has(key) || lastAlertKeyRef.current === key) return;
          const stamped = {
            ...alert,
            id: alertIdRef.current++,
            key,
            time: (packet.timestamp || '').split('.')[0] || 'LIVE'
          };
          // Keep a larger backlog so older insights remain scrollable
          next = [stamped, ...next].slice(0, 200);
          existingKeys.add(key);
          lastAlertKeyRef.current = key;
        });

        return next;
      });
      
      // Keep history for the live graph (200 points for smooth traces)
      setHistory(prev => {
        const newHistory = [...prev, { 
          time: packet.timestamp, 
          speed: cleanSpeed, 
          rpm: cleanRpm,
          throttle: packet.throttle || 0,
          brake: packet.brake || 0
        }];
        return newHistory.slice(-200);  // Keep last 200 points
      });
    });

    return () => socket.disconnect();
  }, []);

  // --- GPS PROJECTION HELPER ---
  // Converts Lat/Long to SVG X/Y Coordinates (0-100 range)
  const projectGPS = (lat, long) => {
    if (!trackData.bounds) return { x: 50, y: 50 };
    const { min_lat, max_lat, min_long, max_long } = trackData.bounds;
    
    // Prevent divide by zero
    const latRange = max_lat - min_lat || 1;
    const longRange = max_long - min_long || 1;

    // Normalize to 0-1
    const xNorm = (long - min_long) / longRange;
    const yNorm = (lat - min_lat) / latRange;

    // Scale to Percentage (Add padding so it doesn't touch edges)
    return {
      x: 10 + (xNorm * 80),
      y: 90 - (yNorm * 80) // Invert Y for SVG because SVG Y goes down
    };
  };

  // Smooth GPS and G-force to avoid jittery jumps on the UI
  useEffect(() => {
    if (!data) return;
    const hasBounds = trackData?.bounds && Number.isFinite(trackData.bounds.min_lat);
    const fallbackPos = trackData?.start ? projectGPS(trackData.start.lat, trackData.start.long) : { x: 50, y: 50 };
    const targetPos = hasBounds ? projectGPS(data.lat, data.long) : fallbackPos;
    setCarPos(prev => {
      const blend = 0.08; // smoother to avoid dot jitter
      return {
        x: clamp(prev.x + (targetPos.x - prev.x) * blend, 4, 96),
        y: clamp(prev.y + (targetPos.y - prev.y) * blend, 4, 96),
      };
    });

    const targetGX = clamp(Number(data.g_lat || 0), -2.2, 2.2);
    const targetGY = clamp(Number(data.g_long || 0), -2.2, 2.2);
    setGVector(prev => {
      const blend = 0.2;
      return {
        x: prev.x + (targetGX - prev.x) * blend,
        y: prev.y + (targetGY - prev.y) * blend,
      };
    });
  }, [data, data?.lat, data?.long, data?.g_lat, data?.g_long, trackData?.bounds, trackData?.start]);

  // Show Loading Screen until data arrives
  if (!data) return (
    <div className="h-screen bg-black text-red-500 flex flex-col items-center justify-center font-mono tracking-widest">
      <div className="animate-pulse text-4xl font-black mb-4">GR ANALYTICS</div>
      <div className="text-xs border border-red-900 p-2 rounded bg-red-950/20">INITIALIZING SYSTEM...</div>
      <div className="text-xs text-gray-600 mt-2">{status}</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-black text-gray-300 p-3 font-mono text-xs overflow-hidden selection:bg-red-900 selection:text-white">
      
      {/* --- HEADER --- */}
      <header className="flex justify-between items-center border-b border-gray-800 pb-2 mb-3">
          <div className="flex items-center gap-4">
            <div className="bg-red-600 text-black px-4 py-1 font-black text-2xl skew-x-[-12deg] border-r-4 border-white">
              TOYOTA <span className="text-white">GR</span>
            </div>
            <div>
              <div className="text-[10px] text-gray-500 tracking-[0.2em] flex items-center gap-2">
                SESSION: RACE 1
                <span className="flex items-center gap-1 text-red-500 font-bold">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"></span>
                  REC
                </span>
              </div>
              <div className="text-white font-bold text-sm">BARBER MOTORSPORTS PARK</div>
            </div>
          </div>
          <div className="flex gap-8">
            <div className="text-right">
              <div className="text-[10px] text-gray-500">LAP</div>
              <div className="text-2xl font-black text-white leading-none">
                {data.lap} <span className="text-sm text-gray-600">/ {data.total_laps || 22}</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-gray-500">UTC TIME</div>
              <div className="text-lg font-bold text-white tabular-nums leading-none">
                {displayTime || (data.timestamp && data.timestamp.split('.')[0]) || '--:--:--'}
              </div>
            </div>
          </div>
      </header>

      {/* --- GRID --- */}
      {/* Layout aligned to wireframe:
         - Left: Engine (rows 1-3), Tire (rows 4-6), Dynamics (rows 7-9) equal heights.
         - Center: Track map (cols 4-9, rows 1-6); Speed/RPM graph (cols 4-9, rows 7-10).
         - Right: Insights (cols 10-12, rows 1-5), Strategy log (cols 10-12, rows 6-10).
      */}
      <div className="grid grid-cols-12 grid-rows-[repeat(12,minmax(0,1fr))] gap-3 h-[calc(100vh-90px)]">
        
        {/* 1. SPEED & ENGINE (Top Left) - col 1, rows 1-4 */}
        <div className="col-span-3 row-span-4 row-start-1 bg-neutral-900/30 border border-gray-800 rounded p-4 flex flex-col justify-between relative min-h-0 h-full">
           {/* RPM Bar */}
           <div
             className="absolute top-0 left-0 h-1 bg-gradient-to-r from-green-500 via-yellow-500 to-red-600"
             style={{width: `${clamp((Number(displayEngine.rpm || 0) / 8000) * 100, 0, 100)}%`}}
           ></div>
           
          <div className="flex justify-between text-gray-500 items-center">
            <span className="flex items-center gap-2">ENGINE<Zap size={14}/></span>
            <span className="text-yellow-400 text-[10px] font-bold">GEAR {data.gear ?? 0} / 6</span>
          </div>
           
           <div className="text-center">
              <div className="text-8xl font-black text-white tabular-nums tracking-tighter leading-none">{Math.round(displayEngine.speed)}</div>
              <div className="text-xs font-bold text-gray-600 mt-2">KM/H</div>
           </div>
           
           <div className="flex justify-end items-end mt-2">
              <div className="text-right">
                 <div className="text-xl font-bold text-white tabular-nums leading-none">{Math.round(displayEngine.rpm)}</div>
                 <div className="text-[9px] text-gray-500 mt-1">RPM</div>
              </div>
           </div>
        </div>

        {/* 2. TRACK MAP HERO (Center) - col 4-9, rows 1-8 */}
        <div className="col-span-6 col-start-4 row-span-8 row-start-1 bg-neutral-900/20 border border-gray-800 rounded relative flex items-center justify-center overflow-hidden h-full">
           {/* Background Grid */}
           <div className="absolute inset-0 bg-[linear-gradient(rgba(50,50,50,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(50,50,50,0.1)_1px,transparent_1px)] bg-[size:20px_20px]"></div>
           
           <div className="absolute top-3 left-3 bg-black/50 backdrop-blur px-2 py-1 rounded border-l-2 border-red-600 z-10">
              <div className="text-[10px] text-gray-400">GPS LIVE</div>
              <div className="text-white font-mono">{data.lat.toFixed(5)}, {data.long.toFixed(5)}</div>
           </div>
           <div className="absolute top-3 right-3 text-gray-400 text-[10px] font-bold tracking-widest bg-black/50 px-2 py-1 rounded border border-gray-800 z-10">
             BARBER MOTORSPORTS PARK
           </div>

           {/* THE MAP SVG */}
           <svg viewBox="0 0 100 100" className="w-full h-full p-4 filter drop-shadow-[0_0_10px_rgba(255,255,255,0.1)]">
              {/* Base Track Line (Precomputed from Server) */}
              {trackData.shape.length > 0 && (
                <polyline 
                  points={trackData.shape.map(p => {
                    const pos = projectGPS(p.lat, p.long);
                    return `${pos.x},${pos.y}`;
                  }).join(' ')}
                  fill="none"
                  stroke="#333"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {/* Track labels/sections */}
              {trackLabels.map((m, idx) => {
                const labelWidth = m.label.length > 2 ? 8 : 6.5;
                const labelHeight = 5;
                return (
                  <g key={`label-${idx}`}>
                    {m.bg ? (
                      <rect
                        x={m.x - labelWidth / 2}
                        y={m.y - labelHeight / 2}
                        width={labelWidth}
                        height={labelHeight}
                        rx={0.7}
                        fill={m.bg}
                        opacity="0.92"
                      />
                    ) : null}
                    <text
                      x={m.x}
                      y={m.y + 0.7}
                      fontSize="2.2"
                      textAnchor="middle"
                      fill={m.bg ? '#fff' : '#9ca3af'}
                      fontWeight={m.bg ? '700' : '600'}
                      style={{ pointerEvents: 'none' }}
                    >
                      {m.label}
                    </text>
                  </g>
                );
              })}
              {trackData.start && (
                <circle
                  cx={projectGPS(trackData.start.lat, trackData.start.long).x}
                  cy={projectGPS(trackData.start.lat, trackData.start.long).y}
                  r="1.8"
                  fill="#ffffff"
                  stroke="#111827"
                  strokeWidth="0.5"
                />
              )}
              
              {/* The Car Dot with Pulsating Animation */}
              <g>
                {/* Outer pulsating ring */}
                <circle 
                  cx={carPos.x} 
                  cy={carPos.y} 
                  r="1.5" 
                  fill="none" 
                  stroke="#ef4444" 
                  strokeWidth="0.3"
                  opacity="0.6"
                  style={{
                    animation: 'pulse-ring 1.5s ease-out infinite',
                  }}
                />
                {/* Core car dot */}
                <circle 
                  cx={carPos.x} 
                  cy={carPos.y} 
                  r="1.5" 
                  fill="#ef4444" 
                  stroke="white" 
                  strokeWidth="0.5"
                  style={{
                    animation: 'pulse-dot 1.2s ease-in-out infinite',
                    filter: 'drop-shadow(0 0 2px #ef4444)',
                  }}
                />
              </g>
              <style>{`
                @keyframes pulse-ring {
                  0% {
                    r: 1.5;
                    opacity: 0.8;
                  }
                  100% {
                    r: 4;
                    opacity: 0;
                  }
                }
                @keyframes pulse-dot {
                  0%, 100% {
                    r: 1.5;
                    filter: drop-shadow(0 0 2px #ef4444);
                  }
                  50% {
                    r: 1.8;
                    filter: drop-shadow(0 0 4px #ef4444);
                  }
                }
              `}</style>
           </svg>
        </div>

        {/* 3. G-FORCE & INPUTS (Left bottom) - col 1-3, rows 9-12 (equal size with Engine and Tire) */}
        <div className="col-span-3 col-start-1 row-start-9 row-span-4 bg-neutral-900/30 border border-gray-800 rounded p-4 flex flex-col gap-2 overflow-hidden min-h-0 h-full">
          <div className="flex justify-between text-gray-500 items-center">
            <span className="flex items-center gap-2">DYNAMICS <Disc size={14}/></span>
            <span className="text-[10px] text-gray-600">{status}</span>
          </div>

          <div className="flex-1 bg-black/30 border border-gray-800 rounded-lg flex gap-3 px-3 py-3 items-center">
            {/* Weather Section - Left Side (2x2 Grid) */}
            <div className="flex flex-col gap-2 flex-1">
              {data.weather ? (
                <div className="grid grid-cols-2 gap-2">
                  <WeatherCell label="TEMPERATURE" value={`${data.weather.temp_c.toFixed(0)}° C`} accent="bg-orange-400" />
                  <WeatherCell label="TRACK" value={`${data.weather.track_temp_c.toFixed(0)}° C`} accent="bg-red-400" />
                  <WeatherCell label="WIND" value={`${data.weather.wind_kph} kph`} accent="bg-blue-400" />
                  <WeatherCell label="HUMID" value={`${data.weather.humidity}%`} accent="bg-cyan-400" />
                </div>
              ) : (
                <div className="text-[10px] text-gray-600 bg-neutral-900/40 border border-dashed border-gray-800 rounded p-2">Awaiting weather feed...</div>
              )}
            </div>

            {/* G-Force Circle - Right Side */}
            <div className="flex flex-col items-center justify-center gap-2 flex-[0_0_auto]">
              <div className="w-[80px] h-[80px] border border-gray-700 rounded-full relative bg-neutral-950 overflow-hidden">
                <div className="absolute top-1/2 left-0 w-full h-[1px] bg-gray-800"></div>
                <div className="absolute left-1/2 top-0 h-full w-[1px] bg-gray-800"></div>
                <div className="absolute inset-2 border border-gray-800 rounded-full"></div>
                <div 
                  className="w-3 h-3 bg-red-500 rounded-full absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-transform duration-150 ease-out shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                  style={{ 
                    transform: `translate(calc(-50% + ${gVector.x * 11}px), calc(-50% - ${gVector.y * 11}px))`
                  }}
                ></div>
              </div>
              <div className="text-[9px] text-gray-400 text-center">|g| {gMagnitude.toFixed(2)}</div>
            </div>
          </div>

          {/* Pedals - Bottom Full Width */}
          <div className="flex items-end gap-2 h-12">
            <div className="flex-1 bg-gray-800 rounded-t relative overflow-hidden">
              <div className="absolute bottom-0 w-full bg-green-500 transition-all duration-150" style={{height: `${clamp(data.throttle ?? 0, 0, 100)}%`}}></div>
              <div className="absolute top-1 w-full text-center text-[7px] font-bold text-white mix-blend-difference">THR</div>
            </div>
            <div className="flex-1 bg-gray-800 rounded-t relative overflow-hidden">
              <div className="absolute bottom-0 w-full bg-red-600 transition-all duration-150" style={{height: `${clamp(data.brake ?? 0, 0, 100)}%`}}></div>
              <div className="absolute top-1 w-full text-center text-[7px] font-bold text-white mix-blend-difference">BRK</div>
            </div>
          </div>
       </div>


        {/* 4. TIRE HEALTH (Middle Left) - col 1-3, rows 5-8 */}
        <div className="col-span-3 row-span-4 col-start-1 row-start-5 bg-neutral-900/30 border border-gray-800 rounded p-4 min-h-0 flex flex-col h-full">
           <div className="flex justify-between text-gray-500 items-center mb-2">
             <span>TIRE MODEL</span>
             <span className="text-[10px] text-gray-500 flex items-center gap-1"><Thermometer size={12}/>WEAR {(100 - data.tire_health).toFixed(1)}%</span>
           </div>
           
           <div className="flex flex-1 items-center justify-center gap-6 py-2">
              {/* Left Tires */}
              <div className="space-y-4">
                 <TireBadge val={(data.tire_healths && data.tire_healths.fl) || data.tire_health} label="FL" />
                 <TireBadge val={(data.tire_healths && data.tire_healths.rl) || data.tire_health} label="RL" />
              </div>
              {/* Car Outline */}
              <div className="h-24 w-10 border-2 border-gray-700 rounded-t-[10px] rounded-b-[4px] relative">
                 <div className="absolute top-4 left-0 w-full h-[1px] bg-gray-800"></div>
                 <div className="absolute bottom-4 left-0 w-full h-[1px] bg-gray-800"></div>
              </div>
              {/* Right Tires */}
              <div className="space-y-4">
                 <TireBadge val={(data.tire_healths && data.tire_healths.fr) || data.tire_health} label="FR" />
                 <TireBadge val={(data.tire_healths && data.tire_healths.rr) || data.tire_health} label="RR" />
              </div>
           </div>
        </div>

        {/* 5. SESSION INSIGHTS (Top Right) - col 10-12, rows 1-6 */}
        <div className="col-span-3 row-span-6 row-start-1 col-start-10 bg-neutral-900/30 border border-gray-800 rounded p-3 flex flex-col gap-2 overflow-hidden">
          <div className="flex justify-between text-gray-500 text-[10px] font-bold items-center">
            <span>SESSION INSIGHTS</span>
            <span className="flex items-center gap-1">
              {sessionInsights ? <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> : null}
              <span className={sessionInsights ? "text-red-500" : "text-gray-600"}>{sessionInsights ? 'LIVE' : '...loading'}</span>
            </span>
          </div>
          {sessionInsights ? (
            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
              <InsightItem label="Best Lap" value={sessionInsights.best_lap || '--'} sub={sessionInsights.avg_lap ? `Avg ${sessionInsights.avg_lap}` : ''} compact />
              <InsightItem
                label="Latest vs Best"
                value={
                  typeof sessionInsights.latest_vs_best === 'number'
                    ? `${sessionInsights.latest_vs_best.toFixed(2)}s`
                    : (sessionInsights.best_lap_seconds && data?.lap_time_sec
                      ? `${(data.lap_time_sec - sessionInsights.best_lap_seconds).toFixed(2)}s`
                      : '--')
                }
                compact
              />
              <InsightItem label="Best of S1" value={sessionInsights.best_sectors?.S1?.time || '--'} sub={sessionInsights.best_sectors?.S1?.lap ? `Lap ${sessionInsights.best_sectors.S1.lap}` : ''} compact />
              <InsightItem label="Best of S2" value={sessionInsights.best_sectors?.S2?.time || '--'} sub={sessionInsights.best_sectors?.S2?.lap ? `Lap ${sessionInsights.best_sectors.S2.lap}` : ''} compact />
              <InsightItem label="Best of S3" value={sessionInsights.best_sectors?.S3?.time || '--'} sub={sessionInsights.best_sectors?.S3?.lap ? `Lap ${sessionInsights.best_sectors.S3.lap}` : ''} compact />
              <InsightItem label="Top Speed" value={sessionInsights.top_speed_kph ? `${sessionInsights.top_speed_kph.toFixed(1)} km/h` : '--'} compact />
              <InsightItem label="Pits" value={sessionInsights.pit_count ?? 0} sub={sessionInsights.slowest_pit ? `Slowest ${sessionInsights.slowest_pit.toFixed(1)}s` : ''} compact />
              <InsightItem label="Consistency" value={sessionInsights.consistency_std ? `${sessionInsights.consistency_std.toFixed(2)}s` : '--'} compact />
            </div>
          ) : (
            <div className="text-[10px] text-gray-500">Loading insights...</div>
          )}
        </div>

        {/* 6. STRATEGY LOG (Right Middle) - col 10-12, rows 7-12 */}
        <div className="col-span-3 row-span-6 row-start-7 col-start-10 bg-neutral-900/30 border border-gray-800 rounded p-4 flex flex-col">
           <div className="flex justify-between text-gray-500 mb-2 text-[10px]"><span>STRATEGY LOG</span><AlertTriangle size={14}/></div>
           <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar pr-1">
              <AlertBox time="START" msg="Race Session Initialized" type="info" />
              {persistentAlerts.map((a, i) => (
                  <AlertBox key={a.id ?? `alert-${i}`} time={a.time || "LIVE"} msg={a.msg} type={a.type} />
              ))}

              {/* Sector start/end ticks for S1/S2/S3 */}
              {trackSectors.map((sector, idx) => (
                <g key={`sector-${sector.name}-${idx}`}>
                  <line
                    x1={sector.start.x - 1.4}
                    y1={sector.start.y - 2.6}
                    x2={sector.start.x + 1.4}
                    y2={sector.start.y + 2.6}
                    stroke={sector.color}
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    opacity="0.85"
                  />
                  <line
                    x1={sector.end.x - 1.4}
                    y1={sector.end.y - 2.6}
                    x2={sector.end.x + 1.4}
                    y2={sector.end.y + 2.6}
                    stroke={sector.color}
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    opacity="0.85"
                  />
                </g>
              ))}
           </div>
        </div>

        {/* 7. SPEED/RPM GRAPH (Bottom Left) - col 4-6, rows 9-12 */}
        <div className="col-span-3 col-start-4 row-start-9 row-span-4 bg-neutral-900/30 border border-gray-800 rounded p-2 relative">
           <div className="absolute top-2 left-2 text-[10px] text-gray-500 font-bold flex items-center gap-2">
             SPEED / RPM TRACE
           </div>
           <div className="w-full h-full pt-4">
              <ResponsiveContainer width="100%" height="100%">
                 <LineChart data={history}>
                    <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                    <XAxis dataKey="time" hide />
                    <YAxis yAxisId="speed" domain={[0, 260]} stroke="#ef4444" />
                    <YAxis yAxisId="rpm" orientation="right" domain={[0, 9000]} stroke="#22d3ee" />
                    <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1f2937', color: '#e5e7eb' }} />
                    <Legend />
                    <Line 
                       yAxisId="speed"
                       type="monotone" 
                       dataKey="speed" 
                       stroke="#ef4444" 
                       strokeWidth={2} 
                       dot={false} 
                       isAnimationActive={false} 
                       name="Speed (km/h)"
                    />
                    <Line 
                       yAxisId="rpm"
                       type="monotone" 
                       dataKey="rpm" 
                       stroke="#22d3ee" 
                       strokeWidth={1.5} 
                       dot={false} 
                       isAnimationActive={false} 
                       name="RPM"
                    />
                 </LineChart>
              </ResponsiveContainer>
           </div>
        </div>

        {/* 8. THROTTLE/BRAKE GRAPH (Bottom Right) - col 7-9, rows 9-12 */}
        <div className="col-span-3 col-start-7 row-start-9 row-span-4 bg-neutral-900/30 border border-gray-800 rounded p-2 relative">
           <div className="absolute top-2 left-2 text-[10px] text-gray-500 font-bold flex items-center gap-2">
             THROTTLE / BRAKE PRESSURE
           </div>
           <div className="w-full h-full pt-4">
              <ResponsiveContainer width="100%" height="100%">
                 <LineChart data={history}>
                    <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                    <XAxis dataKey="time" hide />
                    <YAxis yAxisId="throttle" domain={[0, 100]} stroke="#ef4444" />
                    <YAxis yAxisId="brake" orientation="right" domain={[0, 100]} stroke="#3b82f6" />
                    <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1f2937', color: '#e5e7eb' }} />
                    <Legend />
                    <Line 
                       yAxisId="throttle"
                       type="monotone" 
                       dataKey="throttle" 
                       stroke="#ef4444" 
                       strokeWidth={2} 
                       dot={false} 
                       isAnimationActive={false} 
                       name="Throttle (%)"
                    />
                    <Line 
                       yAxisId="brake"
                       type="monotone" 
                       dataKey="brake" 
                       stroke="#3b82f6" 
                       strokeWidth={1.5} 
                       dot={false} 
                       isAnimationActive={false} 
                       name="Brake Pressure (%)"
                    />
                 </LineChart>
              </ResponsiveContainer>
           </div>
        </div>

      </div>
    </div>
  );
};

// --- SUB-COMPONENTS ---
const TireBadge = ({ val, label }) => (
   <div className="flex items-center gap-2">
      <div className="text-[10px] font-bold text-gray-500">{label}</div>
      <div className={`w-8 h-10 border rounded flex items-end relative overflow-hidden ${val < 40 ? 'border-red-500' : 'border-green-500'}`}>
         <div className={`w-full transition-all duration-500 ${val < 40 ? 'bg-red-500' : 'bg-green-500'}`} style={{height: `${val}%`}}></div>
      </div>
   </div>
);

const WeatherCell = ({ label, value, accent }) => (
  <div className="flex items-center gap-2 bg-neutral-900/50 border border-gray-800 rounded px-2 py-1.5 min-h-[52px]">
    <div className={`w-1 h-6 rounded-full ${accent || 'bg-slate-500'}`}></div>
    <div className="flex-1">
      <div className="text-[9px] text-gray-500 leading-none">{label}</div>
      <div className="text-[11px] font-bold text-white leading-tight">{value}</div>
    </div>
  </div>
);

const AlertBox = ({ time, msg, type }) => {
   const colors = {
      info: "text-gray-400 border-gray-800",
      warn: "text-yellow-500 border-yellow-900 bg-yellow-900/10",
      success: "text-green-500 border-green-900 bg-green-900/10"
   };
   return (
      <div className={`flex flex-col gap-1 p-2 rounded border text-[9px] ${colors[type] || colors.info}`}>
         <span className="opacity-50 font-mono leading-none">{time}</span>
         <span className="font-bold leading-tight text-left">{msg}</span>
      </div>
   );
}

const InsightItem = ({ label, value, sub }) => (
  <div className="bg-black/30 border border-gray-800 rounded px-2 py-1">
    <div className="text-[8px] text-gray-500 leading-none">{label}</div>
    <div className="text-[11px] font-bold text-white leading-tight">{value ?? '--'}</div>
    {sub ? <div className="text-[7px] text-gray-500 mt-0.5">{sub}</div> : null}
  </div>
);

export default Dashboard;
