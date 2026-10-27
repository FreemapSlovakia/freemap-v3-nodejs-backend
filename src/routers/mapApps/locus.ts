// Docs: https://docs.locusmap.eu/doku.php?id=manual:advanced:customization:online_maps

import { escapeXml } from '../../xml.js';
import { PROVIDERS, type Provider, tokenQuery } from './providers.js';

function providerXml(p: Provider, token: string | null) {
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
    `      <url>${escapeXml(p.url + (p.scales ? '{ts}' : '') + tokenQuery(p, token))}</url>`,
    '      <zoomPart>{z}-8</zoomPart>',
    `      <zoomMin>${p.minZoom + 8}</zoomMin>`,
    `      <zoomMax>${p.maxZoom + 8}</zoomMax>`,
    '      <tileSize>256</tileSize>',
    ...scales,
    `      <countries>${escapeXml(p.countries)}</countries>`,
    `      <usage>${p.overlay ? 'overlay,' : ''}${p.usage}</usage>`,
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
