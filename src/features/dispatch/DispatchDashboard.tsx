import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Battery, BatteryCharging, BatteryLow, BatteryWarning,
  Clock, Package,
} from 'lucide-react';
import {
  supabase,
  type OrderRow,
  type OrderStatus,
  type Profile,
  type DriverStatus,
} from '../../lib/supabase';
import { useProfile } from '../../lib/hooks/useProfile';
import { haversineMeters } from '../../lib/geo';
import { MapWrapper } from '../../components/map/MapWrapper';
import type { MapMarker } from '../../components/map/types';
import { GeofenceAlertsPanel } from './GeofenceAlertsPanel';

const ACTIVE_STATUSES = ['confirmed', 'dispatched', 'picked', 'in_transit'] as const;

const DEFAULT_CENTER = { lat: 6.5244, lng: 3.3792 };
const DEFAULT_ZOOM = 12;
const STALE_MS = 2 * 60 * 1000;
/** Tiny lat/lng offset applied when two drivers report identical coords. */
const CO_LOCATION_OFFSET = 0.00005;

const DRIVER_STATUS_PILL: Record<DriverStatus, string> = {
  available:   'bg-green-100 text-green-700',
  on_delivery: 'bg-blue-100 text-blue-700',
  offline:     'bg-slate-100 text-slate-600',
};

const ORDER_STATUS_PILL: Record<OrderStatus, string> = {
  pending:    'bg-slate-100 text-slate-600',
  confirmed:  'bg-blue-100 text-blue-700',
  dispatched: 'bg-indigo-100 text-indigo-700',
  picked:     'bg-purple-100 text-purple-700',
  in_transit: 'bg-blue-100 text-blue-700',
  delivered:  'bg-green-100 text-green-700',
  cancelled:  'bg-red-100 text-red-700',
  failed:     'bg-red-100 text-red-700',
};

const DRIVER_STATUS_RANK: Record<DriverStatus, number> = {
  on_delivery: 0,
  available: 1,
  offline: 2,
};

type LiveState = 'live' | 'connecting' | 'offline';

const LIVE_DOT: Record<LiveState, string> = {
  live: 'bg-green-500',
  connecting: 'bg-amber-500',
  offline: 'bg-slate-400',
};

const LIVE_LABEL: Record<LiveState, string> = {
  live: 'Live',
  connecting: 'Connecting',
  offline: 'Offline',
};

export interface DriverLocation {
  driver_id: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  battery: number | null;
  is_charging: boolean | null;
  updated_at: string;
}

interface LoadResult {
  drivers: Profile[];
  locations: Record<string, DriverLocation>;
  orders: OrderRow[];
}

function computeTone(d: Profile, loc: DriverLocation): NonNullable<MapMarker['tone']> {
  if (d.driver_status === 'available') return 'success';
  if (d.driver_status === 'on_delivery') return 'primary';
  const age = Date.now() - new Date(loc.updated_at).getTime();
  if (age > STALE_MS) return 'muted';
  return 'muted';
}

function relativeTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function batteryColorClass(level: number): string {
  if (level < 15) return 'text-red-600';
  if (level <= 40) return 'text-amber-600';
  return 'text-green-600';
}

function BatteryIndicator({
  level,
  charging,
}: {
  level: number | null;
  charging: boolean | null;
}) {
  if (level === null) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400">
        <Battery className="h-3 w-3" />
        —
      </span>
    );
  }
  const cls = batteryColorClass(level);
  let Icon = Battery;
  if (charging === true) Icon = BatteryCharging;
  else if (level < 15) Icon = BatteryWarning;
  else if (level <= 40) Icon = BatteryLow;
  return (
    <span className={`inline-flex items-center gap-1 ${cls}`}>
      <Icon className="h-3 w-3" />
      {level}%
    </span>
  );
}

/**
 * ETA requires destination coordinates. `OrderRow` in src/lib/supabase.ts does
 * NOT declare delivery_lat / delivery_lng, so we defensively probe the row at
 * runtime; if those fields are absent (they currently are) we always return
 * null and the UI renders "ETA: —".
 */
function computeEta(driverLoc: DriverLocation | undefined, order: OrderRow): number | null {
  if (!driverLoc) return null;
  const maybe = order as OrderRow & {
    delivery_lat?: number | null;
    delivery_lng?: number | null;
  };
  const dLat = maybe.delivery_lat;
  const dLng = maybe.delivery_lng;
  if (typeof dLat !== 'number' || typeof dLng !== 'number') return null;
  const meters = haversineMeters(
    { lat: driverLoc.lat, lng: driverLoc.lng },
    { lat: dLat, lng: dLng },
  );
  return Math.round((meters / 1000 / 25) * 60) + 5;
}

export function DispatchDashboard() {
  const { profile, loading: profileLoading } = useProfile();

  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [locations, setLocations] = useState<Record<string, DriverLocation>>({});
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [panTo, setPanTo] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<LiveState>('connecting');

  // Visible driver set is fixed for the session. Held in a ref so the realtime
  // callback always reads the latest value without re-subscribing.
  const visibleDriverIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    visibleDriverIdsRef.current = new Set(drivers.map((d) => d.id));
  }, [drivers]);

  const load = useCallback(async (): Promise<LoadResult> => {
    if (!profile) return { drivers: [], locations: {}, orders: [] };

    let driversQuery = supabase
      .from('profiles')
      .select('id,user_id,email,full_name,phone,role,branch_id,driver_status,is_active')
      .eq('role', 'driver')
      .eq('is_active', true);

    if (profile.role !== 'master') {
      if (!profile.branch_id) return { drivers: [], locations: {}, orders: [] };
      driversQuery = driversQuery.eq('branch_id', profile.branch_id);
    }

    const { data: driversData, error: driversErr } = await driversQuery;
    if (driversErr) throw driversErr;
    const visibleDrivers = (driversData as Profile[]) ?? [];

    if (visibleDrivers.length === 0) return { drivers: [], locations: {}, orders: [] };

    const driverIds = visibleDrivers.map((d) => d.id);

    // Battery columns added here so the side panel can show telemetry.
    const { data: locsData, error: locsErr } = await supabase
      .from('driver_locations')
      .select('driver_id,lat,lng,accuracy,battery,is_charging,updated_at')
      .in('driver_id', driverIds);
    if (locsErr) throw locsErr;

    const locMap: Record<string, DriverLocation> = {};
    for (const row of (locsData as DriverLocation[] | null) ?? []) {
      locMap[row.driver_id] = row;
    }

    const { data: ordersData, error: ordersErr } = await supabase
      .from('orders')
      .select('*')
      .in('assigned_driver_id', driverIds)
      .in('status', [...ACTIVE_STATUSES]);
    if (ordersErr) throw ordersErr;

    return {
      drivers: visibleDrivers,
      locations: locMap,
      orders: (ordersData as OrderRow[]) ?? [],
    };
  }, [profile]);

  // Initial fetch on mount (unchanged behaviour).
  useEffect(() => {
    if (profileLoading) return;
    if (!profile) { setLoading(false); return; }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const result = await load();
        if (cancelled) return;
        setDrivers(result.drivers);
        setLocations(result.locations);
        setOrders(result.orders);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load dispatch data';
        setError(message);
        toast.error(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [profile, profileLoading, load]);

  // Realtime deltas after the initial load. Single channel, two listeners.
  useEffect(() => {
    if (!profile) return;
    if (loading) return; // wait for the initial fetch to settle

    const channel = supabase
      .channel('dispatch-dashboard')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_locations' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as { driver_id?: string };
            if (!oldRow.driver_id) return;
            if (!visibleDriverIdsRef.current.has(oldRow.driver_id)) return;
            setLocations((prev) => {
              const next = { ...prev };
              delete next[oldRow.driver_id as string];
              return next;
            });
            return;
          }
          const row = payload.new as DriverLocation | null;
          if (!row || !row.driver_id) return;
          // Out-of-scope drivers are ignored; the visible set is fixed for the session.
          if (!visibleDriverIdsRef.current.has(row.driver_id)) return;
          setLocations((prev) => ({ ...prev, [row.driver_id]: row }));
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as { id?: string };
            if (!oldRow.id) return;
            setOrders((prev) => prev.filter((o) => o.id !== oldRow.id));
            return;
          }

          const row = payload.new as Partial<OrderRow> | null;
          if (!row || !row.id) return;
          const id = row.id;
          const status = row.status;
          const driverId = row.assigned_driver_id ?? null;

          // Terminal statuses remove the order from the panel.
          if (status === 'delivered' || status === 'cancelled') {
            setOrders((prev) => prev.filter((o) => o.id !== id));
            return;
          }

          const isActive = !!status && (ACTIVE_STATUSES as readonly string[]).includes(status);
          const inScope = !!driverId && visibleDriverIdsRef.current.has(driverId);

          if (isActive && inScope) {
            setOrders((prev) => {
              const without = prev.filter((o) => o.id !== id);
              return [...without, row as OrderRow];
            });
          }
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setLiveState('live');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setLiveState('connecting');
        else if (status === 'CLOSED') setLiveState('offline');
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profile, loading]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    const coordCounts = new Map<string, number>();
    for (const d of drivers) {
      const loc = locations[d.id];
      if (!loc) continue;
      const key = `${loc.lat.toFixed(6)}|${loc.lng.toFixed(6)}`;
      const idx = coordCounts.get(key) ?? 0;
      coordCounts.set(key, idx + 1);
      // Co-located drivers get a tiny offset so pins stay individually clickable.
      const offset = idx * CO_LOCATION_OFFSET;
      out.push({
        id: d.id,
        lat: loc.lat + offset,
        lng: loc.lng + offset,
        label: d.full_name ?? d.email,
        tone: computeTone(d, loc),
      });
    }
    return out;
  }, [drivers, locations]);

  const center = useMemo(() => {
    if (markers.length === 0) return DEFAULT_CENTER;
    let lat = 0;
    let lng = 0;
    for (const m of markers) { lat += m.lat; lng += m.lng; }
    return { lat: lat / markers.length, lng: lng / markers.length };
  }, [markers]);

  const sortedDrivers = useMemo(
    () =>
      [...drivers].sort(
        (a, b) => DRIVER_STATUS_RANK[a.driver_status] - DRIVER_STATUS_RANK[b.driver_status],
      ),
    [drivers],
  );

  const ordersByDriver = useMemo(() => {
    const m = new Map<string, OrderRow[]>();
    for (const o of orders) {
      if (!o.assigned_driver_id) continue;
      const arr = m.get(o.assigned_driver_id) ?? [];
      arr.push(o);
      m.set(o.assigned_driver_id, arr);
    }
    return m;
  }, [orders]);

  const focusDriver = useCallback((id: string) => {
    setPanTo(null);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => setPanTo(id));
    } else {
      setPanTo(id);
    }
  }, []);

  if (profileLoading || loading) return <div className="p-6">Loading…</div>;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dispatch</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            {drivers.length} driver{drivers.length === 1 ? '' : 's'} · {orders.length} active
            order{orders.length === 1 ? '' : 's'}
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <span className={`inline-block h-2 w-2 rounded-full ${LIVE_DOT[liveState]}`} />
            {LIVE_LABEL[liveState]}
          </span>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <MapWrapper
            center={center}
            zoom={DEFAULT_ZOOM}
            markers={markers}
            follow={false}
            focusMarkerId={panTo}
            className="h-96 w-full rounded-lg"
          />
        </div>

        <div className="md:col-span-1 space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-3 py-2 text-sm font-medium text-slate-600">
              Drivers
            </div>

            {sortedDrivers.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-400">
                No active drivers in scope.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {sortedDrivers.map((d) => {
                  const loc = locations[d.id];
                  const driverOrders = ordersByDriver.get(d.id) ?? [];
                  return (
                    <li
                      key={d.id}
                      onClick={() => focusDriver(d.id)}
                      className="cursor-pointer px-3 py-2 text-sm hover:bg-slate-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-slate-800">
                          {d.full_name ?? d.email}
                        </span>
                        <span
                          className={`shrink-0 rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${DRIVER_STATUS_PILL[d.driver_status]}`}
                        >
                          {d.driver_status.replace('_', ' ')}
                        </span>
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
                        <BatteryIndicator
                          level={loc?.battery ?? null}
                          charging={loc?.is_charging ?? null}
                        />
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {loc ? `last seen ${relativeTime(loc.updated_at)}` : 'no location yet'}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Package className="h-3 w-3" />
                          {driverOrders.length} active order{driverOrders.length === 1 ? '' : 's'}
                        </span>
                      </div>

                      {driverOrders.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {driverOrders.map((o) => {
                            const eta = computeEta(loc, o);
                            return (
                              <li
                                key={o.id}
                                className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5 text-[11px]"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <code className="truncate font-mono text-slate-700">
                                    {o.tracking_code}
                                  </code>
                                  <span
                                    className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${ORDER_STATUS_PILL[o.status]}`}
                                  >
                                    {o.status.replace('_', ' ')}
                                  </span>
                                </div>
                                <div className="truncate text-slate-600">{o.delivery_address}</div>
                                <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-400">
                                  <span>{relativeTime(o.created_at)}</span>
                                  <span>{eta === null ? 'ETA: —' : `est. ${eta} min`}</span>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <GeofenceAlertsPanel />
        </div>
      </div>
    </div>
  );
}
