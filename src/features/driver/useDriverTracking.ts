import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import {
  Play, Square, CheckCircle2, Wifi, WifiOff, Truck,
  PackageCheck, Navigation, Loader2,
  Battery, BatteryCharging, BatteryLow, BatteryWarning, X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase, type OrderRow } from '../../lib/supabase';
import { useProfile } from '../../lib/hooks/useProfile';
import { useDriverTracking, type GpsMode } from './useDriverTracking';

const ACTIVE_STATUSES = ['confirmed', 'dispatched', 'picked', 'in_transit'] as const;

const MODE_PILL_CLASS: Record<GpsMode, string> = {
  HIGH:     'border-green-200 bg-green-50 text-green-700',
  BALANCED: 'border-blue-200 bg-blue-50 text-blue-700',
  LOW:      'border-amber-200 bg-amber-50 text-amber-700',
  PASSIVE:  'border-slate-200 bg-slate-100 text-slate-600',
};

const OEM_BATTERY_KILLERS = [
  'xiaomi', 'redmi', 'huawei', 'honor', 'oppo', 'realme', 'vivo',
  'oneplus', 'samsung', 'asus', 'meizu', 'nokia', 'transsion',
  'tecno', 'infinix', 'itel',
] as const;

function detectOemBatteryKiller(manufacturer: string | null | undefined): string | null {
  if (!manufacturer) return null;
  const m = manufacturer.toLowerCase();
  for (const kw of OEM_BATTERY_KILLERS) {
    if (m.includes(kw)) return manufacturer;
  }
  return null;
}

interface BatteryState {
  level: number | null;
  charging: boolean | null;
}

function useDeviceBattery(): BatteryState {
  const [state, setState] = useState<BatteryState>({ level: null, charging: null });

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const info = await Device.getBatteryInfo();
          if (cancelled) return;
          setState({
            level: typeof info.batteryLevel === 'number' ? Math.round(info.batteryLevel * 100) : null,
            charging: typeof info.isCharging === 'boolean' ? info.isCharging : null,
          });
          return;
        }

        const nav = navigator as Navigator & {
          getBattery?: () => Promise<{ level: number; charging: boolean }>;
        };
        if (typeof nav.getBattery === 'function') {
          const b = await nav.getBattery();
          if (cancelled) return;
          setState({ level: Math.round(b.level * 100), charging: b.charging });
          return;
        }

        if (!cancelled) setState({ level: null, charging: null });
      } catch (err) {
        console.error('Failed to read device battery for display', err);
        if (!cancelled) setState({ level: null, charging: null });
      }
    };

    void read();
    const id = window.setInterval(() => { void read(); }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return state;
}

function batteryVisuals(level: number, charging: boolean): { Icon: typeof Battery; colorClass: string } {
  let Icon: typeof Battery;
  if (charging) {
    Icon = BatteryCharging;
  } else if (level < 15) {
    Icon = BatteryWarning;
  } else if (level <= 40) {
    Icon = BatteryLow;
  } else {
    Icon = Battery;
  }

  const colorClass =
    level < 15 ? 'text-red-600' :
    level <= 40 ? 'text-amber-600' :
    'text-green-600';

  return { Icon, colorClass };
}

interface NextAction {
  next: string;
  label: string;
  Icon: typeof PackageCheck;
  className: string;
}

function nextActionFor(status: string): NextAction | null {
  switch (status) {
    case 'confirmed':
    case 'dispatched':
      return { next: 'picked', label: 'Picked up', Icon: PackageCheck, className: 'bg-blue-600 hover:bg-blue-700' };
    case 'picked':
      return { next: 'in_transit', label: 'In transit', Icon: Navigation, className: 'bg-indigo-600 hover:bg-indigo-700' };
    case 'in_transit':
      return { next: 'delivered', label: 'Delivered', Icon: CheckCircle2, className: 'bg-green-600 hover:bg-green-700' };
    default:
      return null;
  }
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  dispatched: 'Dispatched',
  picked: 'Picked up',
  in_transit: 'In transit',
  delivered: 'Delivered',
};

const MILESTONES = ['picked', 'in_transit', 'delivered'] as const;
const MILESTONE_LABEL: Record<string, string> = {
  picked: 'Picked up',
  in_transit: 'Transit',
  delivered: 'Delivered',
};

function milestoneIndex(status: string): number {
  switch (status) {
    case 'confirmed':
    case 'dispatched': return -1;
    case 'picked': return 0;
    case 'in_transit': return 1;
    case 'delivered': return 2;
    default: return -1;
  }
}

export function DriverShift() {
  const { profile } = useProfile();
  const [onShift, setOnShift] = useState(false);
  const [activeOrders, setActiveOrders] = useState<OrderRow[]>([]);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [shiftBusy, setShiftBusy] = useState(false);
  const [oemBannerManufacturer, setOemBannerManufacturer] = useState<string | null>(null);
  const [oemBannerDismissed, setOemBannerDismissed] = useState(false);

  const { isTracking, queueSize, lastSentAt, lastError, gpsMode, flush } =
    useDriverTracking({ enabled: onShift });

  const battery = useDeviceBattery();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;

    (async () => {
      try {
        const info = await Device.getInfo();
        if (cancelled) return;
        const hit = detectOemBatteryKiller(info.manufacturer);
        if (hit) setOemBannerManufacturer(hit);
      } catch (err) {
        console.error('Failed to read device info for OEM banner', err);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;

    const load = async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('assigned_driver_id', profile.id)
        .in('status', [...ACTIVE_STATUSES])
        .order('created_at');
      if (error) toast.error(error.message);
      if (!cancelled) setActiveOrders((data as OrderRow[]) ?? []);
    };

    void load();
    const ch = supabase
      .channel(`driver-orders-${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `assigned_driver_id=eq.${profile.id}` }, () => { void load(); })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [profile]);

  async function toggleShift() {
    if (!profile) return;
    setShiftBusy(true);
    const next = onShift ? 'offline' : 'available';
    const { error } = await supabase.rpc('set_my_driver_status', { p_status: next });
    if (error) toast.error(error.message);
    else setOnShift(!onShift);
    setShiftBusy(false);
  }

  async function advance(orderId: string, nextStatus: string) {
    setBusyOrderId(orderId);
    const { error } = await supabase.rpc('advance_order_status', {
      p_order_id: orderId,
      p_next_status: nextStatus,
    });
    if (error) {
      console.error('Failed to advance order status', error);
      toast.error(error.message);
    } else {
      toast.success('Order updated');
    }
    setBusyOrderId(null);
  }

  if (!profile) return <div className="p-4">Loading…</div>;

  const batteryView = battery.level !== null ? batteryVisuals(battery.level, battery.charging === true) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Driver shift</h1>
          <p className="text-xs text-slate-500">
            {isTracking ? 'Tracking active' : 'Tracking off'}
            {lastSentAt && ` · last sent ${new Date(lastSentAt).toLocaleTimeString()}`}
            {queueSize > 0 && ` · ${queueSize} queued`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${MODE_PILL_CLASS[gpsMode]}`}
            title={`GPS mode: ${gpsMode}`}
          >
            {gpsMode}
          </span>

          {batteryView && battery.level !== null && (
            <span className={`inline-flex items-center gap-1 text-xs font-medium ${batteryView.colorClass}`} title={`Battery ${battery.level}%`}>
              <batteryView.Icon className="h-3.5 w-3.5" />
              {battery.level}%
            </span>
          )}

          <button onClick={toggleShift} disabled={shiftBusy} className={`flex items-center gap-2 rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${onShift ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}>
            {onShift ? <><Square className="h-4 w-4" /> End shift</> : <><Play className="h-4 w-4" /> Start shift</>}
          </button>
        </div>
      </header>

      <div className="flex items-center gap-3 rounded border border-slate-200 bg-white px-3 py-2 text-xs">
        {queueSize === 0
          ? <><Wifi className="h-3.5 w-3.5 text-green-600" /> In sync</>
          : <><WifiOff className="h-3.5 w-3.5 text-amber-600" /> {queueSize} fixes buffered <button className="underline" onClick={() => void flush()}>retry</button></>}
        {lastError && <span className="ml-auto text-red-600">{lastError}</span>}
      </div>

      {oemBannerManufacturer && !oemBannerDismissed && (
        <div className="relative">
          <a
            href="https://dontkillmyapp.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 pr-9 text-xs text-amber-800 hover:bg-amber-100"
          >
            <BatteryWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span className="flex-1">
              Battery optimisation on {oemBannerManufacturer} devices may stop background tracking.
              Tap to learn how to fix it.
            </span>
          </a>
          <button
            type="button"
            onClick={() => setOemBannerDismissed(true)}
            aria-label="Dismiss battery optimisation notice"
            className="absolute right-1.5 top-1.5 rounded p-1 text-amber-700 hover:bg-amber-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-600">
          Active deliveries
          {activeOrders.length > 0 && <span className="ml-1 text-slate-400">({activeOrders.length})</span>}
        </h2>

        {activeOrders.length === 0 && <p className="text-sm text-slate-400">No active deliveries.</p>}

        {activeOrders.map((o) => {
          const action = nextActionFor(o.status);
          const isBusy = busyOrderId === o.id;
          const step = milestoneIndex(o.status);

          return (
            <div key={o.id} className="rounded border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{o.delivery_address}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    <Truck className="h-3.5 w-3.5" />
                    <span className="uppercase">{STATUS_LABEL[o.status] ?? o.status}</span>
                    <span>·</span>
                    <code className="rounded bg-slate-100 px-1">{o.tracking_code}</code>
                  </div>
                  <div className="mt-3 flex items-center gap-1">
                    {MILESTONES.map((_, i) => (
                      <div key={i} className={`h-1.5 flex-1 rounded ${i <= step ? 'bg-blue-600' : 'bg-slate-200'}`} />
                    ))}
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wide text-slate-400">
                    {MILESTONES.map((m) => <span key={m}>{MILESTONE_LABEL[m]}</span>)}
                  </div>
                </div>

                {action && (
                  <button onClick={() => advance(o.id, action.next)} disabled={isBusy} className={`flex shrink-0 items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${action.className}`}>
                    {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <action.Icon className="h-3.5 w-3.5" />}
                    {action.label}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
