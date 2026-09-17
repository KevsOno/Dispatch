import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import maplibregl, { Map as MLMap, Marker as MLMarker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
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

export interface MapLibreMapHandle {
  /** Close the in-progress polygon and fire onPolygonComplete. */
  finishPolygon: () => void;
  /** Discard the in-progress polygon. */
  cancelPolygon: () => void;
}

interface ExtendedProps extends MapWrapperProps {
  drawMode?: boolean;
  onPolygonComplete?: (polygon: GeoJSON.Polygon) => void;
  geofences?: GeofencePolygon[];
}

const STYLE_URL =
  (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ??
  'https://demotiles.maplibre.org/style.json';

const DRAW_SOURCE = 'draw-source';
const DRAW_LINE = 'draw-line';
const DRAW_POINTS = 'draw-points';
const CLOSE_DISTANCE_PX = 20;

export const MapLibreMap = forwardRef<MapLibreMapHandle, ExtendedProps>(function MapLibreMap(
  {
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
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<
    Map<string, { marker: MLMarker; tone: NonNullable<MapMarker['tone']>; label?: string }>
  >(new Map());

  const verticesRef = useRef<[number, number][]>([]);
  const onPolygonCompleteRef = useRef(onPolygonComplete);
  useEffect(() => { onPolygonCompleteRef.current = onPolygonComplete; }, [onPolygonComplete]);

  const drawModeRef = useRef(drawMode);
  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);

  const finishPolygonRef = useRef<() => void>(() => {});
  const cancelPolygonRef = useRef<() => void>(() => {});

  useImperativeHandle(ref, () => ({
    finishPolygon: () => finishPolygonRef.current(),
    cancelPolygon: () => cancelPolygonRef.current(),
  }), []);

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

    const renderDraw = () => {
      const vertices = verticesRef.current;
      const features: GeoJSON.Feature[] = [];
      if (vertices.length > 0) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: vertices },
        });
        for (const coord of vertices) {
          features.push({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: coord },
          });
        }
      }
      const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
      const src = map.getSource(DRAW_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(fc as GeoJSON.FeatureCollection<GeoJSON.Geometry>);
    };

    const ensureDrawLayers = () => {
      if (!map.getSource(DRAW_SOURCE)) {
        map.addSource(DRAW_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
      }
      if (!map.getLayer(DRAW_LINE)) {
        map.addLayer({
          id: DRAW_LINE,
          type: 'line',
          source: DRAW_SOURCE,
          filter: ['==', '$type', 'LineString'],
          paint: { 'line-color': '#111827', 'line-width': 2, 'line-dasharray': [2, 2] },
        });
      }
      if (!map.getLayer(DRAW_POINTS)) {
        map.addLayer({
          id: DRAW_POINTS,
          type: 'circle',
          source: DRAW_SOURCE,
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-radius': 5,
            'circle-color': '#111827',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });
      }
    };

    const finishPolygon = () => {
      const vertices = verticesRef.current;
      if (vertices.length < 3) {
        verticesRef.current = [];
        renderDraw();
        return;
      }
      const ring = [...vertices, vertices[0]];
      const polygon: GeoJSON.Polygon = { type: 'Polygon', coordinates: [ring] };
      verticesRef.current = [];
      renderDraw();
      onPolygonCompleteRef.current?.(polygon);
    };

    const cancelPolygon = () => {
      verticesRef.current = [];
      renderDraw();
    };

    finishPolygonRef.current = finishPolygon;
    cancelPolygonRef.current = cancelPolygon;

    // Add a vertex on single-click
    const onMapClick = (e: maplibregl.MapMouseEvent) => {
      if (!drawModeRef.current) return;
      const coord: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      const vertices = verticesRef.current;

      // Close if clicked near the first vertex
      if (vertices.length >= 3) {
        const firstPt = map.project(vertices[0]);
        const dx = firstPt.x - e.point.x;
        const dy = firstPt.y - e.point.y;
        if (Math.sqrt(dx * dx + dy * dy) <= CLOSE_DISTANCE_PX) {
          finishPolygon();
          return;
        }
      }
      vertices.push(coord);
      renderDraw();
    };

    // Double-click also finishes
    const onMapDblClick = (e: maplibregl.MapMouseEvent) => {
      if (!drawModeRef.current) return;
      e.preventDefault();
      finishPolygon();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!drawModeRef.current) return;
      if (e.key === 'Enter') finishPolygon();
      else if (e.key === 'Escape') cancelPolygon();
    };

    map.on('click', onMapClick);
    map.on('dblclick', onMapDblClick);
    map.once('load', ensureDrawLayers);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle draw cursor
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = drawMode ? 'crosshair' : '';
    if (!drawMode) {
      verticesRef.current = [];
      const src = map.getSource(DRAW_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [drawMode]);

  // Viewport reporter
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

  // Follow center
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !follow) return;
    map.easeTo({ center: [center.lng, center.lat], zoom, duration: 500 });
  }, [center.lat, center.lng, zoom, follow]);

  // Geofence polygons
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
          id: fillId, type: 'fill', source: sourceId,
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 },
        });
        map.addLayer({
          id: lineId, type: 'line', source: sourceId,
          paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
        });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [geofences]);

  // Markers
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

  // Focus marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusMarkerId) return;
    const m = markers.find((x) => x.id === focusMarkerId);
    if (!m) return;
    map.easeTo({ center: [m.lng, m.lat], zoom, duration: 600 });
  }, [focusMarkerId, markers, zoom]);

  return <div ref={containerRef} className={className} />;
});
