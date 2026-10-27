import { escapeXml } from '../../xml.js';
import { PROVIDERS, type Provider, tokenQuery } from './providers.js';

function sourceXml(p: Provider, scale: number, token: string | null) {
  const url =
    p.url.replace(/\{([xyz])\}/g, '{$$$1}') +
    (scale === 1 ? '' : `@${scale}x`) +
    tokenQuery(p, token);

  return [
    // each scale is a map of its own, numbered apart from every base id
    `  <onlinemapsource uid="${scale === 1 ? p.id : p.id * 10 + scale}">`,
    `    <name>${escapeXml(`Freemap ${p.mode}${scale === 1 ? '' : ` @${scale}x`}`)}</name>`,
    `    <url><![CDATA[${url}]]></url>`,
    '    <website><![CDATA[<a href="https://www.freemap.sk/">Freemap</a>]]></website>',
    `    <minzoom>${p.minZoom}</minzoom>`,
    `    <maxzoom>${p.maxZoom}</maxzoom>`,
    `    <projection>MERCATORESFERICA${scale === 1 ? '' : `x${scale * 256}`}</projection>`,
    '    <servers></servers>',
    '    <cacheable>1</cacheable>',
    '    <downloadable>0</downloadable>',
    '    <maxtilesday>0</maxtilesday>',
    '    <maxthreads>0</maxthreads>',
    '    <xop></xop>',
    '    <yop></yop>',
    '    <zop></zop>',
    '    <qop></qop>',
    '    <sop></sop>',
    '  </onlinemapsource>',
  ].join('\n');
}

/** OruxMaps online-map sources; `token` unlocks the premium zooms. */
export function onlineMapSourcesXml(token: string | null) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Freemap maps for OruxMaps: save as oruxmaps/mapfiles/customonlinemaps/onlinemapsources.xml -->',
    '<onlinemapsources>',
    ...PROVIDERS.flatMap((p) =>
      [1, ...(p.scales ?? [])].map((scale) => sourceXml(p, scale, token)),
    ),
    '</onlinemapsources>',
    '',
  ].join('\n');
}
