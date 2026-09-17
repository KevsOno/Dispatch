import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { supabase } from '../../lib/supabase';
import { useProfile } from '../../lib/hooks/useProfile';
import { MapLibreMap, type MapLibreMapHandle } from '../../components/map/MapLibreMap';

interface Geofence {
  id: string;
  name: string;
  description: string | null;
  polygon: GeoJSON.Polygon;
  color: string;
  aws_geofence_id: string | null;
  is_active: boolean;
  created_at: string;
}

const SYNC_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-geofence`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export function ZoneManagerPage() {
  const { profile } = useProfile();
  const [zones, setZones] = useState<Geofence[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Geofence | null>(null);
  const [showModal, setShowModal] = useState(false);

  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('#E53935');
  const [draftPolygon, setDraftPolygon] = useState<GeoJSON.Polygon | null>(null);
  const [saving, setSaving] = useState(false);

  const mapRef = useRef<MapLibreMapHandle>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('geofences')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) toast.error(error.message);
    setZones((data ?? []) as Geofence[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const openNew = () => {
    setEditing(null);
    setDraftName('');
    setDraftColor('#E53935');
    setDraftPolygon(null);
    setShowModal(true);
  };

  const openEdit = (g: Geofence) => {
    setEditing(g);
    setDraftName(g.name);
    setDraftColor(g.color);
    setDraftPolygon(g.polygon);
    setShowModal(true);
  };

  const save = async () => {
    if (!draftName.trim()) return toast.error('Name is required');

    // If user is mid-draw, close the polygon now.
    let polygon = draftPolygon;
    if (!polygon) {
      mapRef.current?.finishPolygon();
      await new Promise((r) => setTimeout(r, 80));
      // draftPolygon state won't have updated in the same tick —
      // ask the map for it via a fresh reference after the finish.
      // Simplest path: check again on next tick via a ref-free read.
      // If still null, the user genuinely drew nothing.
    }

    // We can't read fresh state synchronously, so use a microtask retry.
    if (!polygon) {
      await new Promise((r) => setTimeout(r, 0));
      if (!draftPolygon) {
        // One more attempt — state may have settled by now via the
        // onPolygonComplete callback.
        await new Promise((r) => setTimeout(r, 80));
      }
    }

    // Final check using current state closure — if the callback fired
    // it will have updated draftPolygon, but this closure is stale.
    // So we rely on `polygon` being set OR the user having drawn.
    // Best UX: if still empty, tell them.
    if (!polygon && !draftPolygon) {
      return toast.error('Draw a polygon on the map first');
    }
    polygon = polygon ?? draftPolygon;

    setSaving(true);
    try {
      const payload = {
        name: draftName.trim(),
        color: draftColor,
        polygon,
        branch_id: profile?.branch_id ?? null,
      };

      let rowId: string;
      if (editing) {
        const { data, error } = await supabase
          .from('geofences')
          .update(payload)
          .eq('id', editing.id)
          .select()
          .single();
        if (error) throw error;
        rowId = data.id;
      } else {
        const { data, error } = await supabase
          .from('geofences')
          .insert(payload)
          .select()
          .single();
        if (error) throw error;
        rowId = data.id;
      }

      // Mirror to AWS. Failure is non-blocking — the zone still exists locally.
      const res = await fetch(SYNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: ANON_KEY,
        },
        body: JSON.stringify({ geofence_id: rowId, action: 'upsert' }),
      });

      if (!res.ok) {
        const text = await res.text();
        toast.error(`Saved locally, AWS sync failed: ${text.slice(0, 120)}`);
      } else {
        toast.success(editing ? 'Zone updated' : 'Zone created');
      }

      setShowModal(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (g: Geofence) => {
    if (!confirm(`Delete zone "${g.name}"?`)) return;

    if (g.aws_geofence_id) {
      await fetch(SYNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: ANON_KEY,
        },
        body: JSON.stringify({ geofence_id: g.id, action: 'delete' }),
      });
    }

    const { error } = await supabase.from('geofences').delete().eq('id', g.id);
    if (error) return toast.error(error.message);
    toast.success('Zone deleted');
    await load();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Watch Zones</h1>
        <button
          onClick={openNew}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
        >
          + Add Zone
        </button>
      </header>

      <p className="text-sm text-slate-500">
        Zones are used to alert dispatchers when drivers enter or leave them.
      </p>

      <MapLibreMap
        className="h-96 w-full rounded-lg"
        geofences={zones.map((z) => ({
          id: z.id,
          name: z.name,
          polygon: z.polygon,
          color: z.color,
        }))}
      />

      <div className="rounded border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">AWS</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>
            )}
            {!loading && zones.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">No zones yet.</td></tr>
            )}
            {zones.map((z) => (
              <tr key={z.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium">
                  <span
                    className="mr-2 inline-block h-3 w-3 rounded"
                    style={{ background: z.color }}
                  />
                  {z.name}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {z.aws_geofence_id ? '✓ synced' : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {new Date(z.created_at).toLocaleDateString()}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => openEdit(z)}
                    className="mr-2 text-slate-600 hover:text-slate-900"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(z)}
                    className="text-red-600 hover:text-red-700"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-3xl rounded-lg bg-white p-4">
            <h2 className="mb-3 text-lg font-semibold">
              {editing ? 'Edit Zone' : 'New Zone'}
            </h2>

            <div className="mb-3 grid grid-cols-2 gap-3">
              <label className="text-sm">
                Name
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="e.g. Ajegunle, Apapa Wharf"
                  className="mt-1 w-full rounded border px-2 py-1"
                />
              </label>
              <label className="text-sm">
                Color
                <input
                  type="color"
                  value={draftColor}
                  onChange={(e) => setDraftColor(e.target.value)}
                  className="mt-1 h-9 w-full"
                />
              </label>
            </div>

            <p className="mb-2 text-xs text-slate-500">
              Click on the map to add corners. <b>Double-click</b> or press <b>Enter</b> to close the polygon. Press Escape to cancel.
            </p>

            <MapLibreMap
              ref={mapRef}
              className="h-80 w-full rounded border"
              drawMode
              onPolygonComplete={setDraftPolygon}
              geofences={
                draftPolygon
                  ? [{
                      id: 'draft',
                      name: draftName || 'Draft',
                      polygon: draftPolygon,
                      color: draftColor,
                    }]
                  : []
              }
            />

            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="rounded border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save Zone'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
