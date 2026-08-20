import assert from 'node:assert/strict';
import test from 'node:test';
import { isPhotoTitle } from './pageTitleFilter.js';

/**
 * Titles are in the page dump's underscore form. Every rejected case below is a
 * real Commons title from a bulk upload that was visibly gridding the map.
 */
const REJECTED = [
  // Wrong format entirely — orthophoto rasters that don't even thumbnail.
  'Brandenburg_DOP20_2019_tile.tif',
  'DOP40_-_Landkreis_Passau_32797_5393_(Bayerische_Vermessungsverwaltung).tif',

  // Orthophoto tiles in ordinary photo formats, band suffix and all.
  'LVermGeoRP_-_DOP20RGB_-_364000_5505000_-_RP_-_2025.png',
  'Dop10rgb_32_4870_58885_05_hb_2025.jpg',
  'Dop20rgb_32553_5928_1_hh_2016.jpg',
  'Dop20c_32580_5938_(Sommerbefliegung_2013).jpg',
  'Orthophoto_Mosaic_Tile_1234.jpg',

  // Aerial survey flight frames.
  'Bildflug_001,_Streifen_10,_Bildnummer_1415-1473_-_LABW_-_Staatsarchiv_Sigmaringen_Wü_160_T_5_Nr._001_-27.jpg',
  'Bildflug_005A,_Streifen_XXIV,_Bildnummer_3476-3483_-_LABW_-_Staatsarchiv_Sigmaringen_Wü_160_T_5_Nr._005A_-5.jpg',

  // Shot from orbit.
  'ISS028-E-25372_-_View_of_Earth.jpg',
  'AS11-40-5875_Aldrin.jpg',
];

const KEPT = [
  'Bratislavský_hrad_2019.jpg',
  'Kostol_v_Žiline.JPEG',
  'S48E017_view.jpg',

  // `Doppel…` must survive the DOP designator pattern.
  'Doppelhaus_in_Berlin-Pankow.jpg',
  'Doppelkirche_Schwarzrheindorf.jpg',

  // …and so must words whose fourth letter is accented, which an ASCII-only
  // boundary would read as the end of a bare `DOP` token.
  'Dopĺňanie_vody_do_studne.jpg',
  'Dopředu_k_nádraží.jpg',

  // Each aerial-survey term on its own is an ordinary word.
  'Diensdorf,_Informationstafel_am_Betkreuz,_Bildflug_vom_23._März_2022.jpg',
  'Streifen_am_Zebrastreifen.jpg',
];

test('isPhotoTitle rejects bulk survey and orbital uploads', () => {
  for (const title of REJECTED) {
    assert.equal(isPhotoTitle(title), false, title);
  }
});

test('isPhotoTitle keeps ordinary ground photographs', () => {
  for (const title of KEPT) {
    assert.equal(isPhotoTitle(title), true, title);
  }
});
