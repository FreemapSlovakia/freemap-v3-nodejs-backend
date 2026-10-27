// Docs: https://docs.locusmap.eu/doku.php?id=manual:advanced:customization:online_maps

import { escapeXml } from '../../xml.js';

type Provider = {
  // stable: Locus keys the user's choice and tile cache by it
  id: number;
  mode: string;
  url: string;
  minZoom: number;
  maxZoom: number;
  // the server's premium zooms need the token
  gated?: boolean;
  scales?: number[];
  countries: string;
  usage: string;
  attribution: string;
};

const OUTDOOR = 'https://outdoor.tiles.freemap.sk';

const OUTDOOR_ATTRIBUTION = 'Freemap Slovakia & OpenStreetMap contributors';

const LLS_ATTRIBUTION = 'LLS: ÚGKK SR';

const OFM_ATTRIBUTION = 'GKÚ Bratislava, NLC';

const overlay = (
  id: number,
  mode: string,
  route: string,
  minZoom: number,
  usage: string,
): Provider => ({
  id,
  mode,
  url: `${OUTDOOR}/o/${route}/{z}/{x}/{y}`,
  minZoom,
  maxZoom: 20,
  gated: true,
  scales: [2, 3],
  countries: 'Europe',
  usage: `overlay,${usage}`,
  attribution: OUTDOOR_ATTRIBUTION,
});

const PROVIDERS: Provider[] = [
  {
    id: 846007,
    mode: 'Outdoor',
    url: `${OUTDOOR}/{z}/{x}/{y}`,
    minZoom: 5,
    maxZoom: 20,
    gated: true,
    scales: [2, 3, 4],
    countries: 'Europe',
    usage: 'cycle,hiking,road,ski',
    attribution: OUTDOOR_ATTRIBUTION,
  },
  {
    id: 846008,
    mode: 'KST Hiking Trails',
    url: `${OUTDOOR}/kst/{z}/{x}/{y}`,
    minZoom: 5,
    maxZoom: 20,
    gated: true,
    scales: [2, 3, 4],
    countries: 'Europe',
    usage: 'hiking',
    attribution: OUTDOOR_ATTRIBUTION,
  },
  overlay(846010, 'Outdoor map without base', 'aerial', 5, 'cycle,hiking'),
  overlay(846011, 'Hiking trails', 'hiking', 9, 'hiking'),
  overlay(846012, 'Bicycle trails', 'bicycle', 9, 'cycle'),
  overlay(846013, 'Ski trails', 'ski', 9, 'ski'),
  overlay(846014, 'Horse trails', 'horse', 9, 'hiking'),
  overlay(846015, 'MTB difficulty', 'mtb', 12, 'cycle'),
  overlay(846016, 'Hiking difficulty', 'sac', 12, 'hiking'),
  overlay(846017, 'Road smoothness', 'smoothness', 12, 'cycle,road'),
  overlay(846018, 'Contour lines', 'contours', 12, 'hiking'),
  {
    id: 846009,
    mode: 'Detailed hillshading',
    url: 'https://sk-hires-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxZoom: 20,
    gated: true,
    countries: 'Slovakia',
    usage: 'aero',
    attribution: LLS_ATTRIBUTION,
  },
  {
    id: 846005,
    mode: 'DMP1 hillshading',
    url: 'https://dmp1-shading.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxZoom: 18,
    countries: 'Slovakia',
    usage: 'aero',
    attribution: LLS_ATTRIBUTION,
  },
  {
    id: 846006,
    mode: 'Orthophoto',
    url: 'https://ortofoto.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxZoom: 20,
    gated: true,
    countries: 'Slovakia,Czech Republic',
    usage: 'photo',
    attribution: `${OFM_ATTRIBUTION}, ČÚZK`,
  },
  {
    id: 846003,
    mode: 'Orthophoto SR 2017–2019',
    url: 'https://ofmozaika1c.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxZoom: 19,
    countries: 'Slovakia',
    usage: 'photo',
    attribution: OFM_ATTRIBUTION,
  },
  {
    id: 846002,
    mode: 'Orthophoto SR 2020–2022',
    url: 'https://ofmozaika2c.tiles.freemap.sk/{z}/{x}/{y}.jpg',
    minZoom: 0,
    maxZoom: 19,
    countries: 'Slovakia',
    usage: 'photo',
    attribution: OFM_ATTRIBUTION,
  },
  {
    id: 846001,
    mode: 'Lesné cesty NLC',
    url: 'https://nlc.tiles.freemap.sk/{z}/{x}/{y}.png',
    minZoom: 11,
    maxZoom: 15,
    countries: 'Slovakia',
    usage: 'cycle,hiking,road',
    attribution: 'Národné lesnícke centrum',
  },
];

function providerXml(p: Provider, token: string | null) {
  const query = p.gated && token ? `?token=${token}` : '';

  const scales = p.scales
    ? [
        '      <tileScales>',
        '        <tileScale dpi="0" multi="1.0" replace="" />',
        ...p.scales.map(
          (s) =>
            `        <tileScale dpi="${s * 160}" multi="${s}.0" replace="@${s}x" />`,
        ),
        '      </tileScales>',
      ]
    : [];

  // Locus zoom levels are offset by 8
  return [
    `  <provider id="${p.id}" type="0" visible="true" required="false" background="-1">`,
    '      <name>Freemap</name>',
    `      <mode>${escapeXml(p.mode)}</mode>`,
    `      <url>${escapeXml(p.url + (p.scales ? '{ts}' : '') + query)}</url>`,
    '      <zoomPart>{z}-8</zoomPart>',
    `      <zoomMin>${p.minZoom + 8}</zoomMin>`,
    `      <zoomMax>${p.maxZoom + 8}</zoomMax>`,
    '      <tileSize>256</tileSize>',
    ...scales,
    `      <countries>${escapeXml(p.countries)}</countries>`,
    `      <usage>${p.usage}</usage>`,
    `      <attribution>${escapeXml(p.attribution)}</attribution>`,
    '  </provider>',
  ].join('\n');
}

/** Locus online-map providers; `token` unlocks the premium zooms. */
export function providersXml(token: string | null) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<providers>',
    ...PROVIDERS.map((p) => providerXml(p, token)),
    '</providers>',
    '',
  ].join('\n');
}

/** A Locus Actions file that installs `providersUrl` and the group icon. */
export function actionsXml(providersUrl: string, iconUrl: string) {
  // the icon first: refreshMap after the providers should find it in place
  return `<?xml version="1.0" encoding="UTF-8"?>
<locusActions>
  <download>
    <source><![CDATA[${iconUrl}]]></source>
    <dest><![CDATA[/mapsOnline/custom/Freemap.png]]></dest>
  </download>
  <download>
    <source><![CDATA[${providersUrl}]]></source>
    <dest><![CDATA[/mapsOnline/custom/locus-providers.xml]]></dest>
    <after>refreshMap</after>
  </download>
</locusActions>
`;
}
