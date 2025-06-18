export type DownloadableMap = {
  type: string;
  url: string;
  extraScales?: number[];
  minZoom: number;
  maxNativeZoom: number;
  creditsPerMTile: number;
  attributuion: string;
};

export const downloadableMaps: DownloadableMap[] = [
  {
    type: 'X',
    url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}',
    extraScales: [2, 3],
    minZoom: 6,
    maxNativeZoom: 19,
    creditsPerMTile: 5000,
    attributuion: 'TODO',
  },
  {
    type: 'A',
    url: '//tile.freemap.sk/A/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 'T',
    url: '//tile.freemap.sk/T/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 'C',
    url: '//tile.freemap.sk/C/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 'K',
    url: '//tile.freemap.sk/K/{z}/{x}/{y}.jpeg',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 'Z',
    url: 'https://ortofoto.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 20,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 'J',
    url: 'https://ofmozaika1c.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 19,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: '4',
    url: 'https://dmr5-light-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 18,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: '7',
    url: 'https://sk-hires-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 20,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: '5',
    url: 'https://dmr5-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 18,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: '6',
    url: 'https://dmp1-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxNativeZoom: 18,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 'l',
    url: 'https://nlc.tiles.freemap.sk/{z}/{x}/{y}.png',
    minZoom: 11,
    maxNativeZoom: 15,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 't',
    url: '//tiles.freemap.sk/trails/{z}/{x}/{y}.png',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
  {
    type: 'c',
    url: '//tiles.freemap.sk/cycle/{z}/{x}/{y}.png',
    minZoom: 8,
    maxNativeZoom: 16,
    creditsPerMTile: 1000,
    attributuion: 'TODO',
  },
];
