import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';

export interface GeofenceEvent {
  id: string;
  geofence_id: string;
  driver_id: string;
  event_type: 'enter' | 'exit';
  lat: number;
  lng: number;
  occurred_at: string;
  // Enriched client-side from lookup tables
  geofence_name: string;
  geofence_color: string;
  driver_name: string;
}

interface RawEvent {
  id: string;
  geofence_id: string;
  driver_id: string;
  event_type: 'enter' | 'exit';
  lat: number;
  lng: number;
  occurred_at: string;
}

function enrichOne(
  raw: RawEvent,
  geofenceMap: Map<string, { name: string; color: string }>,
  driverMap: Map<string, string>,
): GeofenceEvent {
  const g = geofenceMap.get(raw.geofence_id);
  return {
    ...raw,
    geofence_name: g?.name ?? 'Unknown zone',
    geofence_color: g?.color ?? '#64748b',
    driver_name: driverMap.get(raw.driver_id) ?? 'Unknown driver',
  };
}

export function useGeofenceEvents(limit = 15) {
  const [events, setEvents] = useState<GeofenceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const geofenceMapRef = useRef<Map<string, { name: string; color: string }>>(new Map());
  const driverMapRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      // Build the enrichment lookups once.
      const [{ data: geofences }, { data: profiles }] = await Promise.all([
        supabase.from('geofences').select('id, name, color'),
        supabase.from('profiles').select('id, full_name, email'),
      ]);
      if (cancelled) return;

      for (const g of (geofences ?? []) as Array<{ id: string; name: string; color: string }>) {
        geofenceMapRef.current.set(g.id, { name: g.name, color: g.color });
      }
      for (const p of (profiles ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string;
      }>) {
        driverMapRef.current.set(p.id, p.full_name ?? p.email);
      }

      // Initial page of events.
      const { data: rawEvents, error: evErr } = await supabase
        .from('geofence_events')
        .select('id, geofence_id, driver_id, event_type, lat, lng, occurred_at')
        .order('occurred_at', { ascending: false })
        .limit(limit);

      if (cancelled) return;
      if (evErr) {
        setError(evErr.message);
        setLoading(false);
        return;
      }

      setEvents(
        (rawEvents ?? []).map((r) =>
          enrichOne(r as RawEvent, geofenceMapRef.current, driverMapRef.current),
        ),
      );
      setLoading(false);

      // Subscribe to new inserts.
      channel = supabase
        .channel('geofence-events-live')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'geofence_events' },
          (payload) => {
            const raw = payload.new as RawEvent;
            const enriched = enrichOne(
              raw,
              geofenceMapRef.current,
              driverMapRef.current,
            );
            setEvents((prev) => [enriched, ...prev].slice(0, limit));
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [limit]);

  return { events, loading, error };
}
