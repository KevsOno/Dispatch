import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap, Marker as MLMarker } from 'maplibre-gl';
import MapboxDraw from '@maplibre/maplibre-gl-draw';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-draw/dist/mapbox-gl-draw.css';
import type { MapWrapperProps, MapMarker } from './types';

const TONE_COLORS: Record<NonNullable<MapMarker['tone']>, string> = {
  primary: '#2563eb',
  muted: '#64748b',
  success: '#16a34a',
  warning: '#d97706',
};

function makePinElement(tone: NonNullable<MapMarker['tone']>): HTMLElement {
  const color = TONE_COLORS[tone];
  const el = document.createElement('div');
  el.style.width = '28px';
  el.style.height = '36px';
  el.style.cursor = 'pointer';
  el.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">
      <path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.3 21.7 0 14 0z" fill="${color}"/>
      <circle cx="14" cy="14" r="5.5" fill="#fff"/>
    </svg>`;
  return el;
}

interface GeofencePolygon {
  id: string;
  name: string;
  polygon: GeoJSON.Polygon;
  color: string;
}

interface ExtendedProps extends MapWrapperProps {
  drawMode?: boolean;
  onPolygonComplete?: (polygon: GeoJSON.Polygon) => void;
  /** Geofences to render as filled polygons. */
  geofences?: GeofencePolygon[];
}

const STYLE_URL =
  (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ??
  'https://demotiles.maplibre.org/style.json';

export function MapLibreMap({
  center = { lat: 6.5244, lng: 3.3792 },
  zoom = 12,
  markers = [],
  className = 'h-96 w-full rounded-lg',
  follow = true,
  focusMarkerId = null,
  onViewportChange,
  drawMode = false,
  onPolygonComplete,
  geofences = [],
}: ExtendedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const markersRef = useRef<
    Map<string, { marker: MLMarker; tone: NonNullable<MapMarker['tone']>; label?: string }>
  >(new Map());

  // ── Init map once ──
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [center.lng, center.lat],
      zoom,
      validateStyle: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
      drawRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Draw mode ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!drawMode) {
      if (drawRef.current) {
        map.removeControl(drawRef.current);
        drawRef.current = null;
      }
      return;
    }

    if (drawRef.current) return;

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
      defaultMode: 'draw_polygon',
    });
    map.addControl(draw, 'top-left');
    drawRef.current = draw;

    const handleCreate = () => {
      const data = draw.getAll();
      if (data.features.length === 0) return;
      const f = data.features[data.features.length - 1];
      if (f.geometry.type !== 'Polygon') return;
      // Clear previous shapes so only one polygon is on the map at a time.
      const ids = data.features.map((ft) => ft.id).filter(Boolean) as string[];
      for (const id of ids) draw.delete(id);
      draw.add(f);
      onPolygonComplete?.(f.geometry as GeoJSON.Polygon);
    };

    map.on('draw.create', handleCreate);
    map.on('draw.update', handleCreate);

    return () => {
      map.off('draw.create', handleCreate);
      map.off('draw.update', handleCreate);
    };
  }, [drawMode, onPolygonComplete]);

  // ── Viewport reporter ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !onViewportChange) return;
    const handler = () => {
      const c = map.getCenter();
      onViewportChange({ center: { lat: c.lat, lng: c.lng }, zoom: map.getZoom() });
    };
    map.on('moveend', handler);
    return () => { map.off('moveend', handler); };
  }, [onViewportChange]);

  // ── Follow center ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !follow) return;
    map.easeTo({ center: [center.lng, center.lat], zoom, duration: 500 });
  }, [center.lat, center.lng, zoom, follow]);

  // ── Geofence polygons ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const sourceId = 'geofences-source';
    const fillId = 'geofences-fill';
    const lineId = 'geofences-line';

    const apply = () => {
      const fc: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: geofences.map((g) => ({
          type: 'Feature',
          id: g.id,
          properties: { name: g.name, color: g.color },
          geometry: g.polygon,
        })),
      };

      const existing = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(fc as GeoJSON.FeatureCollection<GeoJSON.Geometry>);
      } else {
        map.addSource(sourceId, { type: 'geojson', data: fc });
        map.addLayer({
          id: fillId,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': 0.15,
          },
        });
        map.addLayer({
          id: lineId,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 2,
          },
        });
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [geofences]);

  // ── Markers ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      const tone = m.tone ?? 'primary';
      const existing = markersRef.current.get(m.id);

      if (existing) {
        existing.marker.setLngLat([m.lng, m.lat]);
        if (existing.tone !== tone) {
          existing.marker.remove();
          const rebuilt = new maplibregl.Marker({ element: makePinElement(tone), anchor: 'bottom' })
            .setLngLat([m.lng, m.lat]);
          if (m.label) rebuilt.setPopup(new maplibregl.Popup().setText(m.label));
          rebuilt.addTo(map);
          markersRef.current.set(m.id, { marker: rebuilt, tone, label: m.label });
          continue;
        }
        if (existing.label !== m.label) {
          if (m.label) existing.marker.setPopup(new maplibregl.Popup().setText(m.label));
          else existing.marker.setPopup(undefined as unknown as maplibregl.Popup);
          existing.label = m.label;
        }
      } else {
        const marker = new maplibregl.Marker({ element: makePinElement(tone), anchor: 'bottom' })
          .setLngLat([m.lng, m.lat]);
        if (m.label) marker.setPopup(new maplibregl.Popup().setText(m.label));
        marker.addTo(map);
        markersRef.current.set(m.id, { marker, tone, label: m.label });
      }
    }

    for (const [id, entry] of markersRef.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [markers]);

  // ── Focus a marker ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusMarkerId) return;
    const m = markers.find((x) => x.id === focusMarkerId);
    if (!m) return;
    map.easeTo({ center: [m.lng, m.lat], zoom, duration: 600 });
  }, [focusMarkerId, markers, zoom]);

  return <div ref={containerRef} className={className} />;
}
