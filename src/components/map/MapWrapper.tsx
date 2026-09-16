import { MapLibreMap } from './MapLibreMap';
import type { MapWrapperProps } from './types';

/**
 * Provider-agnostic map. Currently renders MapLibre GL JS.
 * Swap the body of this component to change map providers — nothing else
 * in the codebase needs to change.
 */
export function MapWrapper(props: MapWrapperProps) {
  return <MapLibreMap {...props} />;
}
