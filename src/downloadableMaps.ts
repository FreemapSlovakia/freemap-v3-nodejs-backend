export type DownloadableMap = {
  type: string;
  url: string;
  extraScales?: number[];
  minZoom: number;
  maxNativeZoom: number;
  creditsPerMTile: number;
  overlay?: boolean;
  /** What the tiles are; `jpg` unless set. */
  tileFormat?: 'jpg' | 'png';
  /** Rendered by terrain-tiles from the shading the request carries. */
  shading?: true;
} & (
  | { attribution: string }
  | {
      /**
       * The renderer's `GET /licenses`, for a map whose tiles name the datasets
       * they drew from. The renderer is the only authority for its credits.
       */
      licensesUrl: string;
    }
);

export const downloadableMaps: DownloadableMap[] = [
  {
    type: 'X',
    url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}',
    extraScales: [2, 3, 4],
    minZoom: 5,
    maxNativeZoom: 20,
    creditsPerMTile: 5000,
    licensesUrl: 'https://outdoor.tiles.freemap.sk/licenses',
  },
  {
    type: 'h',
    url: 'https://terrain.tiles.freemap.sk/hillshade/{z}/{x}/{y}',
    minZoom: 0,
    maxNativeZoom: 18,
    creditsPerMTile: 1000,
    shading: true,
    licensesUrl: 'https://terrain.tiles.freemap.sk/licenses',
  },
  {
    type: 'A',
    url: 'http://tile.freemap.sk/A/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attribution: 'map: © Freemap Slovakia, data: © OpenStreetMap contributors',
  },
  {
    type: 'T',
    url: 'http://tile.freemap.sk/T/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attribution:
      'map: © Freemap Slovakia, data: © OpenStreetMap contributors, data: © SRTM',
  },
  {
    type: 'C',
    url: 'http://tile.freemap.sk/C/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attribution:
      'map: © Freemap Slovakia, data: © OpenStreetMap contributors, data: © SRTM',
  },
  {
    type: 'K',
    url: 'http://tile.freemap.sk/K/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attribution:
      'map: © Freemap Slovakia, data: © OpenStreetMap contributors, data: © SRTM',
  },
  {
    type: 'Z',
    url: 'https://ortofoto.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 20,
    creditsPerMTile: 1000,
    attribution: 'map: © GKÚ, NLC, map: © ČÚZK',
  },
  {
    type: 'J2',
    url: 'https://ofmozaika2c.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 19,
    creditsPerMTile: 1000,
    attribution: 'map: © GKÚ, NLC',
  },
  {
    type: 'J1',
    url: 'https://ofmozaika1c.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 19,
    creditsPerMTile: 1000,
    attribution: 'map: © GKÚ, NLC',
  },
  {
    type: '4',
    url: 'https://dmr5-light-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 18,
    creditsPerMTile: 1000,
    attribution: 'map: © Freemap Slovakia, data: DMR 5.0: © ÚGKK SR',
  },
  {
    type: '7',
    url: 'https://sk-hires-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 20,
    creditsPerMTile: 1000,
    attribution: 'map: © Freemap Slovakia, data: LLS DMR: © ÚGKK SR',
  },
  {
    type: '5',
    url: 'https://dmr5-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 18,
    creditsPerMTile: 1000,
    attribution: 'map: © Freemap Slovakia, data: DMR 5.0: © ÚGKK SR',
  },
  {
    type: '6',
    url: 'https://dmp1-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 18,
    creditsPerMTile: 1000,
    attribution: 'map: © Freemap Slovakia, data: DMP 1.0: © ÚGKK SR',
  },
  {
    type: 'l1',
    url: 'https://nlc.tiles.freemap.sk/{z}/{x}/{y}.png',
    tileFormat: 'png',
    overlay: true,
    minZoom: 11,
    maxNativeZoom: 15,
    creditsPerMTile: 1000,
    attribution: 'map: © NLC Zvolen',
  },
];
