import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Preferences } from '@capacitor/preferences';
import { Network } from '@capacitor/network';
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
const MIN_INTERVAL_MS = 15_000;
const MIN_DISTANCE_M  = 20;
const BATTERY_CACHE_MS = 30_000;

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
      const info = await Device.getBatteryInfo();
      return {
        p_battery: Math.round(info.batteryLevel * 100),
        p_is_charging: info.isCharging,
      };
    }
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

  const lastSentFix = useRef<QueuedFix | null>(null);
  const watcherId = useRef<{ native: true; id: string } | { native: false; id: string } | null>(null);
  const online = useRef<boolean>(navigator.onLine);
  
  // Mutex lock to prevent race conditions when writing to the queue
  const queueLock = useRef<Promise<void>>(Promise.resolve());

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

  const handleFix = useCallback(async (fix: QueuedFix) => {
    const last = lastSentFix.current;
    const elapsed = last ? Date.now() - last.ts : Infinity;
    const moved = last ? haversineMeters(last, fix) : Infinity;
    const shouldSend = !last || elapsed >= MIN_INTERVAL_MS || moved >= MIN_DISTANCE_M;
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
  }, [enqueueFix]);

  const start = useCallback(async () => {
    if (watcherId.current) return;

    const { connected } = await Network.getStatus();
    online.current = connected;

    if (Capacitor.isNativePlatform()) {
      const id = await BackgroundGeolocation.addWatcher(
        {
          backgroundMessage: 'Tracking your delivery location',
          backgroundTitle: 'LogiFlow — On delivery',
          requestPermissions: true,
          stale: false,
          distanceFilter: 10,
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
    if (enabled && !watcherId.current) void start();
    if (!enabled && watcherId.current) void stop();
  }, [enabled, start, stop]);

  return { isTracking, queueSize, lastSentAt, lastError, start, stop, flush };
}
