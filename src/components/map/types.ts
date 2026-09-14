export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  tone?: 'primary' | 'muted' | 'success' | 'warning';
}

export interface MapWrapperProps {
  center?: { lat: number; lng: number };
  zoom?: number;
  markers?: MapMarker[];
  className?: string;
  /** Recenter the map when `center` changes. Default true. */
  follow?: boolean;
  /**
   * When this changes to a marker id that exists in `markers`, the map pans to
   * that marker. Pass null to indicate "no focus". Re-uses the existing icon
   * system; no new markers are created.
   */
  focusMarkerId?: string | null;
  onViewportChange?: (v: { center: { lat: number; lng: number }; zoom: number }) => void;
}
