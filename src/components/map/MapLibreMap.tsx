import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap, Marker as MLMarker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapWrapperProps, MapMarker } from './types';

const TONE_COLORS: Record<NonNullable<MapMarker['tone']>, string> = {
  primary: '#2563eb',
  muted: '#64748b',
  success: '#16a34a',
  warning: '#d97706',
};

/** Build a fresh pin element per marker (MapLibre appends the element to the DOM). */
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

/** Anchor at bottom-center of the pin, same as Leaflet's iconAnchor: [14, 36]. */
const PIN_ANCHOR: [number, number] = [14, 36];

const STYLE_URL =
  (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) ??
  'https://demotiles.maplibre.org/style.json'; // dev fallback; swap for Amazon Location in prod

export function MapLibreMap({
  center = { lat: 6.5244, lng: 3.3792 },
  zoom = 12,
  markers = [],
  className = 'h-96 w-full rounded-lg',
  follow = true,
  focusMarkerId = null,
  onViewportChange,
}: MapWrapperProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<Map<string, { marker: MLMarker; tone: NonNullable<MapMarker['tone']>; label?: string }>>(new Map());

  // --- Init map once ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [center.lng, center.lat], // NOTE: MapLibre uses [lng, lat]
      zoom,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Viewport reporter ---
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

  // --- Follow center ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !follow) return;
    map.easeTo({ center: [center.lng, center.lat], zoom, duration: 500 });
  }, [center.lat, center.lng, zoom, follow]);

  // --- Sync markers ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();

    for (const m of markers) {
      seen.add(m.id);
      const tone = m.tone ?? 'primary';
      const existing = markersRef.current.get(m.id);

      if (existing) {
        // Position update
        existing.marker.setLngLat([m.lng, m.lat]);

        // Tone change → swap element
        if (existing.tone !== tone) {
          existing.marker.getElement().replaceWith(makePinElement(tone));
          // Note: MapLibre caches the element ref; recreate marker on tone change.
          existing.marker.remove();
          const rebuilt = new maplibregl.Marker({
            element: makePinElement(tone),
            anchor: 'bottom',
            offset: [0, 0],
          })
            .setLngLat([m.lng, m.lat]);
          if (m.label) rebuilt.setPopup(new maplibregl.Popup().setText(m.label));
          rebuilt.addTo(map);
          markersRef.current.set(m.id, { marker: rebuilt, tone, label: m.label });
          continue;
        }

        // Label change → update popup
        if (existing.label !== m.label) {
          if (m.label) existing.marker.setPopup(new maplibregl.Popup().setText(m.label));
          else existing.marker.setPopup(undefined as unknown as maplibregl.Popup);
          existing.label = m.label;
        }
      } else {
        const marker = new maplibregl.Marker({
          element: makePinElement(tone),
          anchor: 'bottom',
        })
          .setLngLat([m.lng, m.lat]);
        if (m.label) marker.setPopup(new maplibregl.Popup().setText(m.label));
        marker.addTo(map);
        markersRef.current.set(m.id, { marker, tone, label: m.label });
      }
    }

    // Remove markers no longer present
    for (const [id, entry] of markersRef.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [markers]);

  // --- Focus a marker ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusMarkerId) return;
    const m = markers.find((x) => x.id === focusMarkerId);
    if (!m) return;
    map.easeTo({ center: [m.lng, m.lat], zoom, duration: 600 });
  }, [focusMarkerId, markers, zoom]);

  return <div ref={containerRef} className={className} />;
}
