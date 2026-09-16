import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Network } from '@capacitor/network';
import { Battery } from '@capawesome-team/capacitor-battery';
import type {
  BackgroundGeolocationPlugin,
  Location,
  CallbackError,
} from '@capacitor-community/background-geolocation';
import { supabase } from '../../lib/supabase';
import { haversineMeters } from '../../lib/geo';
import type { Position } from '@capacitor/geolocation';

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

const QUEUE_KEY = 'logiflow.gps.queue.v1';
const BATTERY_CACHE_MS = 30_000;

export type GpsMode = 'HIGH' | 'BALANCED' | 'LOW' | 'PASSIVE';

interface ModeConfig {
  minIntervalMs: number;
  minDistanceM: number;
  distanceFilter: number;
}

const MODE_CONFIG: Record<GpsMode, ModeConfig> = {
  HIGH:     { minIntervalMs: 0,       minDistanceM: 0,   distanceFilter: 0   },
  BALANCED: { minIntervalMs: 5_000,   minDistanceM: 15,  distanceFilter: 15  },
  LOW:      { minIntervalMs: 30_000,  minDistanceM: 50,  distanceFilter: 50  },
  PASSIVE:  { minIntervalMs: 120_000, minDistanceM: 200, distanceFilter: 200 },
};

const MODE_THRASH_MS = 30_000;
const HIGH_RADIUS_M = 500;
const BALANCED_RADIUS_M = 5_000;
const ACTIVE_ORDER_STATUSES = ['confirmed', 'dispatched', 'picked', 'in_transit'] as const;

interface DeliveryPoint {
  lat: number;
  lng: number;
}

export interface QueuedFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  ts: number;
}

interface Options {
  enabled: boolean;
}

type BatteryReading = {
  p_battery: number | null;
  p_is_charging: boolean | null;
};

interface NavigatorBattery {
  level: number;
  charging: boolean;
}
interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<NavigatorBattery>;
}

let batteryCache: { at: number; promise: Promise<BatteryReading> } | null = null;

async function readBatteryNow(): Promise<BatteryReading> {
  try {
    if (Capacitor.isNativePlatform()) {
      const info = await Battery.getBatteryInfo();

      // Capawesome returns batteryLevel as a number between 0 and 1 on iOS/Android
      // e.g., 0.85 = 85%
      const level = typeof info.batteryLevel === 'number'
        ? Math.round(info.batteryLevel * 100)
        : null;

      return {
        p_battery: level,
        p_is_charging: typeof info.isCharging === 'boolean' ? info.isCharging : null,
      };
    }

    // Fallback for Web/Browser mode
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery === 'function') {
      const b = await nav.getBattery();
      return {
        p_battery: Math.round(b.level * 100),
        p_is_charging: b.charging,
      };
    }

    return { p_battery: null, p_is_charging: null };
  } catch (err) {
    console.error('Failed to read device battery', err);
    return { p_battery: null, p_is_charging: null };
  }
}

function getBatteryCached(): Promise<BatteryReading> {
  const now = Date.now();
  if (batteryCache && now - batteryCache.at < BATTERY_CACHE_MS) {
    return batteryCache.promise;
  }
  const promise = readBatteryNow();
  batteryCache = { at: now, promise };
  return promise;
}

export function useDriverTracking({ enabled }: Options) {
  const [isTracking, setIsTracking] = useState(false);
  const [queueSize, setQueueSize] = useState(0);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [gpsMode, setGpsMode] = useState<GpsMode>('BALANCED');

  const lastSentFix = useRef<QueuedFix | null>(null);
  const watcherId = useRef<{ native: true; id: string } | { native: false; id: string } | null>(null);
  const online = useRef<boolean>(navigator.onLine);

  // Mutex lock to prevent race conditions when writing to the queue
  const queueLock = useRef<Promise<void>>(Promise.resolve());

  // --- GPS cadence mode ---
  const modeRef = useRef<GpsMode>('BALANCED');
  const modeConfigRef = useRef<ModeConfig>(MODE_CONFIG.BALANCED);
  const lastModeChangeRef = useRef<number>(0);
  const deliveriesRef = useRef<DeliveryPoint[]>([]);
  const enabledRef = useRef<boolean>(enabled);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const readQueue = useCallback(async (): Promise<QueuedFix[]> => {
    const { value } = await Preferences.get({ key: QUEUE_KEY });
    if (!value) return [];
    try { return JSON.parse(value) as QueuedFix[]; } catch { return []; }
  }, []);

  const writeQueue = useCallback(async (q: QueuedFix[]) => {
    await Preferences.set({ key: QUEUE_KEY, value: JSON.stringify(q) });
    setQueueSize(q.length);
  }, []);

  // Safe enqueue that uses the mutex
  const enqueueFix = useCallback(async (fix: QueuedFix) => {
    queueLock.current = queueLock.current.then(async () => {
      const q = await readQueue();
      q.push(fix);
      await writeQueue(q);
    });
    return queueLock.current;
  }, [readQueue, writeQueue]);

  const flush = useCallback(async () => {
    // Wait for any pending writes to finish
    await queueLock.current;
    const q = await readQueue();
    if (q.length === 0) return;
    const newest = q.reduce((a, b) => (a.ts > b.ts ? a : b));

    const battery = await getBatteryCached();

    const { error } = await supabase.rpc('upsert_driver_location', {
      p_lat: newest.lat,
      p_lng: newest.lng,
      p_accuracy: newest.accuracy,
      p_battery: battery.p_battery,
      p_is_charging: battery.p_is_charging,
    });

    if (error) { setLastError(error.message); return; }
    await writeQueue([]);
    lastSentFix.current = newest;
    setLastSentAt(Date.now());
    setLastError(null);
  }, [readQueue, writeQueue]);

  const computeMode = useCallback((fix: { lat: number; lng: number }): GpsMode => {
    // Spec: "shift off -> PASSIVE ... treat this as LOW in practice". Because
    // the watcher is removed when the shift ends, computeMode never runs
    // off-shift. We therefore return LOW in that (unreachable) case and
    // surface PASSIVE as hook state when the shift actually turns off.
    if (!enabledRef.current) return 'LOW';

    const pts = deliveriesRef.current;
    if (pts.length === 0) return 'LOW';

    let minDist = Infinity;
    for (const p of pts) {
      const d = haversineMeters(fix, p);
      if (d < minDist) minDist = d;
    }
    if (minDist <= HIGH_RADIUS_M) return 'HIGH';
    if (minDist <= BALANCED_RADIUS_M) return 'BALANCED';
    return 'LOW';
  }, []);

  const handleFix = useCallback(async (fix: QueuedFix) => {
    // Recompute cadence on every fix (even ones we won't send).
    const desired = computeMode(fix);
    if (desired !== modeRef.current) {
      const now = Date.now();
      if (now - lastModeChangeRef.current >= MODE_THRASH_MS) {
        lastModeChangeRef.current = now;
        modeRef.current = desired;
        modeConfigRef.current = MODE_CONFIG[desired];
        setGpsMode(desired);
        // Watcher restart is handled by the effect that observes gpsMode.
      }
    }

    const cfg = modeConfigRef.current;
    const last = lastSentFix.current;
    const elapsed = last ? Date.now() - last.ts : Infinity;
    const moved = last ? haversineMeters(last, fix) : Infinity;
    const shouldSend = !last || elapsed >= cfg.minIntervalMs || moved >= cfg.minDistanceM;
    if (!shouldSend) return;

    if (!online.current) {
      await enqueueFix(fix);
      return;
    }

    const battery = await getBatteryCached();

    const { error } = await supabase.rpc('upsert_driver_location', {
      p_lat: fix.lat,
      p_lng: fix.lng,
      p_accuracy: fix.accuracy,
      p_battery: battery.p_battery,
      p_is_charging: battery.p_is_charging,
    });

    if (error) {
      await enqueueFix(fix);
      setLastError(error.message);
      return;
    }

    lastSentFix.current = fix;
    setLastSentAt(Date.now());
    setLastError(null);
  }, [computeMode, enqueueFix]);

  const start = useCallback(async () => {
    if (watcherId.current) return;

    const { connected } = await Network.getStatus();
    online.current = connected;

    const { distanceFilter } = modeConfigRef.current;

    if (Capacitor.isNativePlatform()) {
      const id = await BackgroundGeolocation.addWatcher(
        {
          backgroundMessage: 'Tracking your delivery location',
          backgroundTitle: 'LogiFlow — On delivery',
          requestPermissions: true,
          stale: false,
          distanceFilter,
        },
        (position?: Location, error?: CallbackError) => {
          if (error) { setLastError(error.message); return; }
          if (!position) return;
          void handleFix({
            lat: position.latitude,
            lng: position.longitude,
            accuracy: position.accuracy ?? null,
            ts: Date.now(),
          });
        },
      );
      watcherId.current = { native: true, id };
    } else {
      // The web watcher has no distanceFilter option: on web the mode only
      // affects the throttling constants inside handleFix.
      const { Geolocation } = await import('@capacitor/geolocation');
      const id = await Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        (pos: Position | null, err?: CallbackError) => {
          if (err) { setLastError(err.message); return; }
          if (!pos) return;
          void handleFix({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? null,
            ts: Date.now(),
          });
        },
      );
      watcherId.current = { native: false, id };
    }

    setIsTracking(true);
    await flush();
  }, [handleFix, flush]);

  const stop = useCallback(async () => {
    const w = watcherId.current;
    if (!w) return;
    if (w.native) {
      await BackgroundGeolocation.removeWatcher({ id: w.id });
    } else {
      const { Geolocation } = await import('@capacitor/geolocation');
      await Geolocation.clearWatch({ id: w.id });
    }
    watcherId.current = null;
    setIsTracking(false);
  }, []);

  // --- Active deliveries: fetch once + keep fresh via Realtime ---
  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const user = auth?.user;
      if (!user || cancelled) return;

      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!profile || cancelled) return;
      const profileId = (profile as { id: string }).id;

      const load = async () => {
        // delivery_lat / delivery_lng are not currently part of the orders schema.
        // We still fetch the row (select *) and probe client-side so that the
        // moment those columns are added, the mode logic starts working without
        // another code change -- and so we do not 400 on a missing column today.
        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .eq('assigned_driver_id', profileId)
          .in('status', [...ACTIVE_ORDER_STATUSES]);
        if (error) {
          console.error('Failed to load active orders for GPS mode', error);
          return;
        }
        if (cancelled) return;
        const pts: DeliveryPoint[] = [];
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          const lat = row.delivery_lat;
          const lng = row.delivery_lng;
          if (typeof lat === 'number' && typeof lng === 'number') {
            pts.push({ lat, lng });
          }
        }
        deliveriesRef.current = pts;
      };

      void load();

      channel = supabase
        .channel(`driver-tracking-orders-${profileId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'orders',
            filter: `assigned_driver_id=eq.${profileId}`,
          },
          () => { void load(); },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, []);

  // --- Restart the watcher when gpsMode changes (post thrash guard) ---
  const didMountRef = useRef(false);
  const restartingRef = useRef(false);

  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (restartingRef.current) return;
    if (!watcherId.current) return;      // not tracking
    if (!enabledRef.current) return;     // shift is off

    restartingRef.current = true;
    void (async () => {
      try {
        await stop();
        if (!enabledRef.current) return;
        await start();
      } finally {
        restartingRef.current = false;
      }
    })();
  }, [gpsMode, start, stop]);

  useEffect(() => {
    const sub = Network.addListener('networkStatusChange', (s) => {
      online.current = s.connected;
      if (s.connected && enabled) void flush();
    });
    return () => { void sub.then((h) => h.remove()); };
  }, [enabled, flush]);

  useEffect(() => {
    const on = () => { online.current = true; void flush(); };
    const off = () => { online.current = false; };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [flush]);

  useEffect(() => { void readQueue().then((q) => setQueueSize(q.length)); }, [readQueue]);

  useEffect(() => {
    if (enabled && !watcherId.current) {
      // Fresh shift: start at BALANCED and clear the thrash window so the
      // first fix can settle the mode immediately.
      modeRef.current = 'BALANCED';
      modeConfigRef.current = MODE_CONFIG.BALANCED;
      lastModeChangeRef.current = 0;
      setGpsMode('BALANCED');
      void start();
    }
    if (!enabled && watcherId.current) {
      void stop();
      // Spec: off-shift is PASSIVE in the hook's state. computeMode() returns
      // LOW in the (unreachable) case of a fix arriving with the shift off;
      // PASSIVE is surfaced here for the UI.
      modeRef.current = 'PASSIVE';
      modeConfigRef.current = MODE_CONFIG.PASSIVE;
      setGpsMode('PASSIVE');
    }
  }, [enabled, start, stop]);

  return { isTracking, queueSize, lastSentAt, lastError, gpsMode, start, stop, flush };
}
