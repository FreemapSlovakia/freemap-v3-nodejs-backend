import assert from 'node:assert/strict';
import test from 'node:test';
import { inCoverage } from './coverage.js';
import {
  forecastOfOpenMeteo,
  OPEN_METEO_HOURLY,
  type OpenMeteoResponse,
  weatherOfWmoCode,
} from './forecast.js';

const T0 = Date.parse('2026-11-20T09:00:00Z');

/** Three hours from T0, every variable 0 unless given. */
function response(
  values: Partial<
    Record<(typeof OPEN_METEO_HOURLY)[number], (number | null)[]>
  >,
): OpenMeteoResponse {
  const time = [0, 1, 2].map((h) => (T0 + h * 3_600_000) / 1000);

  return {
    elevation: 1000,
    hourly: {
      time,
      ...Object.fromEntries(
        OPEN_METEO_HOURLY.map((name) => [name, values[name] ?? [0, 0, 0]]),
      ),
    } as OpenMeteoResponse['hourly'],
  };
}

test('clear and cloudy codes keep their day or night', () => {
  assert.deepEqual(weatherOfWmoCode(2, false), {
    sky: 'partlyCloudy',
    precipitation: null,
    thunder: false,
    day: false,
  });

  assert.equal(weatherOfWmoCode(45, true).sky, 'fog');
});

test('precipitation codes split into type, intensity, showers and thunder', () => {
  assert.deepEqual(weatherOfWmoCode(82, true).precipitation, {
    type: 'rain',
    intensity: 'heavy',
    showers: true,
  });

  assert.deepEqual(weatherOfWmoCode(73, true).precipitation, {
    type: 'snow',
    intensity: 'moderate',
    showers: false,
  });

  assert.equal(weatherOfWmoCode(99, true).thunder, true);
});

test('the amounts say what falls, whatever the code', () => {
  assert.equal(
    weatherOfWmoCode(61, true, 'sleet').precipitation?.type,
    'sleet',
  );

  assert.equal(
    weatherOfWmoCode(71, true, 'sleet').precipitation?.type,
    'sleet',
  );

  // Thundersnow.
  assert.deepEqual(
    [
      weatherOfWmoCode(95, true, 'snow').precipitation?.type,
      weatherOfWmoCode(95, true, 'snow').thunder,
    ],
    ['snow', true],
  );

  // Freezing rain stays sleet.
  assert.equal(weatherOfWmoCode(66, true, 'rain').precipitation?.type, 'sleet');
});

test("a step's sums come from the next hour, its instants from its own", () => {
  const forecast = forecastOfOpenMeteo(
    response({
      temperature_2m: [1, 2, 3],
      precipitation: [9, 0.4, 0.2],
      weather_code: [0, 61, 71],
      snow_depth: [0.12, 0.13, 0.14],
      sunshine_duration: [0, 1800, 3600],
      is_day: [1, 1, 1],
    }),
    1500,
    T0,
  );

  assert.deepEqual(
    forecast.steps.map((s) => [
      s.temperature,
      s.precipitation,
      s.weather.precipitation?.type,
      s.snowDepth,
      s.sunshine,
    ]),
    [
      [1, 0.4, 'rain', 12, 30],
      [2, 0.2, 'snow', 13, 60],
    ],
  );

  assert.equal(forecast.elevation, 1500);
});

test("a bare sky is the step's own, as its cloud layers are", () => {
  // Overcast at 09:00 clearing by 10:00: the 09:00 step is overcast, though
  // the code at 10:00 says clear.
  const [step] = forecastOfOpenMeteo(
    response({
      temperature_2m: [1, 1, 1],
      cloud_cover: [98, 0, 0],
      weather_code: [3, 0, 0],
    }),
    null,
    T0,
  ).steps;

  assert.equal(step?.weather.sky, 'cloudy');
});

test('rain and showers add up, snow apart', () => {
  const [step] = forecastOfOpenMeteo(
    response({
      temperature_2m: [0, 0, 0],
      rain: [0, 0.3, 0],
      showers: [0, 0.2, 0],
      snowfall: [0, 0.7, 0],
      weather_code: [0, 61, 0],
    }),
    null,
    T0,
  ).steps;

  assert.deepEqual(
    [step?.rain, step?.snowfall, step?.weather.precipitation?.type],
    [0.5, 0.7, 'sleet'],
  );
});

test('a polar night or day has no sunrise', () => {
  const om = response({});

  const day = T0 / 1000;

  const forecast = forecastOfOpenMeteo(
    {
      ...om,
      daily: {
        time: [day, day + 86_400, day + 172_800],
        // Night: both at its start; day: from its start to the next; then a
        // plain day.
        sunrise: [day, day + 86_400, day + 172_800 + 21_600],
        sunset: [day, day + 172_800, day + 172_800 + 54_000],
      },
    },
    null,
    T0,
  );

  assert.deepEqual(forecast.sun, [
    { sunrise: null, sunset: null },
    { sunrise: null, sunset: null },
    {
      sunrise: '2026-11-22T15:00:00.000Z',
      sunset: '2026-11-23T00:00:00.000Z',
    },
  ]);
});

test('a trace of snow in rain is no sleet', () => {
  const [step] = forecastOfOpenMeteo(
    response({
      temperature_2m: [0, 0, 0],
      rain: [0, 3, 0],
      snowfall: [0, 0.01, 0],
      weather_code: [0, 63, 0],
    }),
    null,
    T0,
  ).steps;

  assert.equal(step?.weather.precipitation?.type, 'rain');
});

test('past hours and hours beyond the models are left out', () => {
  const forecast = forecastOfOpenMeteo(
    response({ temperature_2m: [1, 2, null] }),
    null,
    T0 + 3_600_000,
  );

  assert.deepEqual(
    forecast.steps.map((s) => s.time),
    ['2026-11-20T10:00:00.000Z'],
  );

  assert.equal(forecast.elevation, 1000);
});

test('Europe is covered, the rest of the world is not', () => {
  assert.equal(inCoverage(48.94, 20.18), true);

  assert.equal(inCoverage(64.15, -21.94), true);

  assert.equal(inCoverage(40.71, -74.0), false);

  assert.equal(inCoverage(55.75, 37.62), false);
});
