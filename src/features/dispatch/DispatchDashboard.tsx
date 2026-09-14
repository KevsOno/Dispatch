import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { supabase, type OrderRow, type Profile } from '../../lib/supabase';
import { useProfile } from '../../lib/hooks/useProfile';

const ACTIVE_STATUSES = ['confirmed', 'dispatched', 'picked', 'in_transit'] as const;

export interface DriverLocation {
  driver_id: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  updated_at: string;
}

interface LoadResult {
  drivers: Profile[];
  locations: Record<string, DriverLocation>;
  orders: OrderRow[];
}

export function DispatchDashboard() {
  const { profile, loading: profileLoading } = useProfile();

  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [locations, setLocations] = useState<Record<string, DriverLocation>>({});
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<LoadResult> => {
    if (!profile) {
      return { drivers: [], locations: {}, orders: [] };
    }

    // a. Drivers the caller is allowed to see.
    let driversQuery = supabase
      .from('profiles')
      .select('id,user_id,email,full_name,phone,role,branch_id,driver_status,is_active')
      .eq('role', 'driver')
      .eq('is_active', true);

    if (profile.role !== 'master') {
      if (!profile.branch_id) {
        return { drivers: [], locations: {}, orders: [] };
      }
      driversQuery = driversQuery.eq('branch_id', profile.branch_id);
    }

    const { data: driversData, error: driversErr } = await driversQuery;
    if (driversErr) throw driversErr;
    const visibleDrivers = (driversData as Profile[]) ?? [];

    if (visibleDrivers.length === 0) {
      return { drivers: [], locations: {}, orders: [] };
    }

    const driverIds = visibleDrivers.map((d) => d.id);

    // b. Latest locations from driver_locations, joined by driver_id.
    const { data: locsData, error: locsErr } = await supabase
      .from('driver_locations')
      .select('driver_id,lat,lng,accuracy,updated_at')
      .in('driver_id', driverIds);
    if (locsErr) throw locsErr;

    const locMap: Record<string, DriverLocation> = {};
    for (const row of (locsData as DriverLocation[] | null) ?? []) {
      locMap[row.driver_id] = row;
    }

    // c. Active orders for those drivers.
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

  useEffect(() => {
    if (profileLoading) return;
    if (!profile) {
      setLoading(false);
      return;
    }

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

    return () => {
      cancelled = true;
    };
  }, [profile, profileLoading, load]);

  if (profileLoading || loading) {
    return <div className="p-6">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dispatch</h1>
        <span className="text-xs text-slate-500">
          {drivers.length} driver{drivers.length === 1 ? '' : 's'} · {orders.length} active
          order{orders.length === 1 ? '' : 's'}
        </span>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <div className="rounded-lg border border-slate-200 bg-white h-96 flex items-center justify-center text-slate-400">
            Map coming in next step
          </div>
        </div>

        <div className="md:col-span-1">
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-3 py-2 text-sm font-medium text-slate-600">
              Drivers
            </div>
            <ul className="divide-y divide-slate-100">
              {drivers.map((d) => (
                <li key={d.id} className="px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-slate-800">
                      {d.full_name ?? d.email}
                    </span>
                    <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-600">
                      {d.driver_status}
                    </span>
                  </div>
                  {locations[d.id] && (
                    <div className="mt-0.5 text-[10px] text-slate-400">
                      updated {new Date(locations[d.id].updated_at).toLocaleTimeString()}
                    </div>
                  )}
                </li>
              ))}
              {drivers.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-slate-400">
                  No drivers visible.
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
