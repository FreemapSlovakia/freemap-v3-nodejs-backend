export type DownloadableMap = {
  type: string;
  url: string;
  extraScales?: number[];
  minZoom: number;
  maxNativeZoom: number;
  creditsPerMTile: number;
  attribution: string;
  overlay?: boolean;
};

export const downloadableMaps: DownloadableMap[] = [
  {
    type: 'X',
    url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}',
    extraScales: [2, 3],
    minZoom: 6,
    maxNativeZoom: 19,
    creditsPerMTile: 5000,
    attribution:
      'map: © Freemap Slovakia, data: © OpenStreetMap contributors, data: DTM providers…',
  },
  {
    type: 'A',
    url: 'http://tile.freemap.sk/A/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attribution:
      'map: © Freemap Slovakia, data: © OpenStreetMap contributors',
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
    type: 'J',
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
    type: 'l',
    url: 'https://nlc.tiles.freemap.sk/{z}/{x}/{y}.png',
    minZoom: 11,
    maxNativeZoom: 15,
    creditsPerMTile: 1000,
    attribution: 'map: © NLC Zvolen',
  },
  {
    type: 't',
    url: 'http://tiles.freemap.sk/trails/{z}/{x}/{y}.png',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attribution:
      'map: © Freemap Slovakia, data: © OpenStreetMap contributors',
  },
  {
    type: 'c',
    url: 'http://tiles.freemap.sk/cycle/{z}/{x}/{y}.png',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attribution:
      'map: © Freemap Slovakia, data: © OpenStreetMap contributors',
  },
];
