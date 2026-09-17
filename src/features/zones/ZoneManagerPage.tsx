import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { supabase } from '../../lib/supabase';
import { useProfile } from '../../lib/hooks/useProfile';
import { MapLibreMap } from '../../components/map/MapLibreMap';

interface Geofence {
  id: string;
  name: string;
  description: string | null;
  polygon: GeoJSON.Polygon;
  color: string;
  fee: number;
  kind: 'coverage' | 'alert';
  aws_geofence_id: string | null;
  is_active: boolean;
  created_at: string;
}

const SYNC_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-geofence`;

export function ZoneManagerPage() {
  const { profile } = useProfile();
  const [zones, setZones] = useState<Geofence[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Geofence | null>(null);
  const [showModal, setShowModal] = useState(false);

  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('#E53935');
  const [draftFee, setDraftFee] = useState(0);
  const [draftKind, setDraftKind] = useState<'coverage' | 'alert'>('coverage');
  const [draftPolygon, setDraftPolygon] = useState<GeoJSON.Polygon | null>(null);
  const [saving, setSaving] = useState(false);

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
    setDraftFee(0);
    setDraftKind('coverage');
    setDraftPolygon(null);
    setShowModal(true);
  };

  const openEdit = (g: Geofence) => {
    setEditing(g);
    setDraftName(g.name);
    setDraftColor(g.color);
    setDraftFee(g.fee);
    setDraftKind(g.kind);
    setDraftPolygon(g.polygon);
    setShowModal(true);
  };

  const save = async () => {
    if (!draftName.trim()) return toast.error('Name is required');
    if (!draftPolygon) return toast.error('Draw a polygon on the map first');

    setSaving(true);
    try {
      const payload = {
        name: draftName.trim(),
        color: draftColor,
        fee: draftFee,
        kind: draftKind,
        polygon: draftPolygon,
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

      // Mirror to AWS — non-blocking failure, log the error but don't block UI
      const res = await fetch(SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geofence_id: rowId, action: 'upsert' }),
      });
      if (!res.ok) {
        const text = await res.text();
        toast.error(`Saved locally, but AWS sync failed: ${text.slice(0, 80)}`);
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
        headers: { 'Content-Type': 'application/json' },
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
        <h1 className="text-xl font-semibold">Delivery Zones</h1>
        <button
          onClick={openNew}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
        >
          + Add Zone
        </button>
      </header>

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
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Fee</th>
              <th className="px-3 py-2">AWS</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>
            )}
            {!loading && zones.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No zones yet.</td></tr>
            )}
            {zones.map((z) => (
              <tr key={z.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium">
                  <span className="mr-2 inline-block h-3 w-3 rounded" style={{ background: z.color }} />
                  {z.name}
                </td>
                <td className="px-3 py-2">{z.kind}</td>
                <td className="px-3 py-2">₦{z.fee.toLocaleString()}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {z.aws_geofence_id ? '✓ synced' : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => openEdit(z)} className="mr-2 text-slate-600 hover:text-slate-900">Edit</button>
                  <button onClick={() => remove(z)} className="text-red-600 hover:text-red-700">Delete</button>
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
              <label className="text-sm">
                Kind
                <select
                  value={draftKind}
                  onChange={(e) => setDraftKind(e.target.value as 'coverage' | 'alert')}
                  className="mt-1 w-full rounded border px-2 py-1"
                >
                  <option value="coverage">Coverage (service area)</option>
                  <option value="alert">Alert (driver leaves → notify)</option>
                </select>
              </label>
              <label className="text-sm">
                Fee (₦, 0 for alert zones)
                <input
                  type="number"
                  value={draftFee}
                  onChange={(e) => setDraftFee(parseInt(e.target.value) || 0)}
                  className="mt-1 w-full rounded border px-2 py-1"
                />
              </label>
            </div>

            <MapLibreMap
              className="h-80 w-full rounded border"
              drawMode
              onPolygonComplete={setDraftPolygon}
              geofences={
                draftPolygon
                  ? [{ id: 'draft', name: draftName || 'Draft', polygon: draftPolygon, color: draftColor }]
                  : []
              }
            />

            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setShowModal(false)} className="rounded border px-3 py-1.5 text-sm">
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
