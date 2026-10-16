import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre v6 locates its worker relative to `import.meta.url`, which a Vite bundle does not preserve. Import
// `maplibregl` from here, never from 'maplibre-gl', so every map gets the bundled worker.
setWorkerUrl(workerUrl);

export * as maplibregl from 'maplibre-gl';
