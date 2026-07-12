import type { PhotoLicense } from './licenses.js';

/**
 * License "families" the map colorizes Wikimedia photos by. The CC families
 * reuse our own-photo license ids (so they share colors); GFDL and PD are extra
 * buckets Commons needs (they have no own-photo equivalent). Anything unmapped
 * stays null → the gallery's fallback license color.
 */
export type WikimediaLicense = PhotoLicense | 'GFDL' | 'PD';

/**
 * Wikidata license item (SDC `P275`, by `numeric-id`) → license family. The raw
 * id is what's stored in `wikimediaPicture.licenseId`; this map is applied at
 * query time, so it can be refined (new ids/families) without re-importing.
 * Commons is dominated by CC-BY / CC-BY-SA / CC0 / GFDL / PD (NonCommercial
 * isn't allowed there); the ~30 entries here cover ~99% of files. Q-ids come
 * from resolving the license items' English labels on Wikidata.
 */
export const LICENSE_Q_MAP: Record<number, WikimediaLicense> = {
  6938433: 'CC0-1.0', // CC0

  // CC BY (1.0–4.0, incl. ports)
  20007257: 'CC-BY-4.0', // 4.0
  14947546: 'CC-BY-4.0', // 3.0 Unported
  75770766: 'CC-BY-4.0', // 3.0 Brazil
  18810333: 'CC-BY-4.0', // 2.5
  19125117: 'CC-BY-4.0', // 2.0
  30942811: 'CC-BY-4.0', // 1.0

  // CC BY-NC (rare on Commons — only as part of a multi-license)
  18810331: 'CC-BY-NC-4.0', // 3.0

  // CC BY-SA (1.0–4.0, incl. ports)
  18199165: 'CC-BY-SA-4.0', // 4.0
  14946043: 'CC-BY-SA-4.0', // 3.0 Unported
  19113751: 'CC-BY-SA-4.0', // 2.5
  19068220: 'CC-BY-SA-4.0', // 2.0
  77143083: 'CC-BY-SA-4.0', // 2.0 Germany
  77355872: 'CC-BY-SA-4.0', // 2.0 France
  77365183: 'CC-BY-SA-4.0', // 2.0 UK
  77367349: 'CC-BY-SA-4.0', // 2.1 Japan
  77366576: 'CC-BY-SA-4.0', // 2.1 Spain
  47001652: 'CC-BY-SA-4.0', // 1.0

  // GNU Free Documentation License
  50829104: 'GFDL', // 1.2 or later
  26921686: 'GFDL', // 1.2
  27019786: 'GFDL', // 1.3

  // Public domain
  98592850: 'PD', // released into the public domain by the copyright holder
  19652: 'PD', // public domain
};
