import { useGeofenceEvents } from './hooks/useGeofenceEvents';

function relativeTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function GeofenceAlertsPanel() {
  const { events, loading, error } = useGeofenceEvents(15);

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span className="text-sm font-medium text-slate-600">Live alerts</span>
        {events.length > 0 && (
          <span className="text-[10px] uppercase tracking-wide text-slate-400">
            {events.length} recent
          </span>
        )}
      </div>

      {loading && (
        <p className="px-3 py-6 text-center text-sm text-slate-400">Loading…</p>
      )}

      {error && (
        <p className="px-3 py-6 text-center text-sm text-red-500">{error}</p>
      )}

      {!loading && !error && events.length === 0 && (
        <p className="px-3 py-6 text-center text-sm text-slate-400">
          No zone activity yet.
        </p>
      )}

      {!loading && events.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {events.map((e) => (
            <li key={e.id} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                  style={{ background: e.geofence_color }}
                />
                <span className="truncate font-medium text-slate-800">
                  {e.driver_name}
                </span>
                <span
                  className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    e.event_type === 'enter'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {e.event_type === 'enter' ? 'entered' : 'left'}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {e.geofence_name}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-400">
                {relativeTime(e.occurred_at)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
