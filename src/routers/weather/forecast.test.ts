import assert from 'node:assert/strict';
import test from 'node:test';
import { forecastOfMet, weatherOfMetSymbol } from './forecast.js';

test('plain skies keep their day or night', () => {
  assert.deepEqual(weatherOfMetSymbol('partlycloudy_night'), {
    sky: 'partlyCloudy',
    precipitation: null,
    thunder: false,
    day: false,
  });

  assert.equal(weatherOfMetSymbol('cloudy').day, true);
});

test('precipitation codes split into type, intensity, showers and thunder', () => {
  assert.deepEqual(weatherOfMetSymbol('heavyrainshowersandthunder_day'), {
    sky: 'partlyCloudy',
    precipitation: { type: 'rain', intensity: 'heavy', showers: true },
    thunder: true,
    day: true,
  });

  assert.deepEqual(weatherOfMetSymbol('snow').precipitation, {
    type: 'snow',
    intensity: 'moderate',
    showers: false,
  });
});

test('a step reaches the next instant, whatever the spacing', () => {
  const instant = {
    details: { air_temperature: 1, wind_speed: 2, cloud_area_fraction: 50 },
  };

  const period = (mm: number) => ({
    summary: { symbol_code: 'rain' },
    details: { precipitation_amount: mm },
  });

  const forecast = forecastOfMet(
    {
      properties: {
        meta: { updated_at: '2026-11-20T09:00:00Z' },
        timeseries: [
          // 3 hours on: half the 6-hour period.
          {
            time: '2026-11-20T09:00:00Z',
            data: { instant, next_1_hours: period(1), next_6_hours: period(6) },
          },
          // No hourly period an hour before the next: a sixth of it.
          {
            time: '2026-11-20T12:00:00Z',
            data: { instant, next_6_hours: period(6) },
          },
          {
            time: '2026-11-20T13:00:00Z',
            data: { instant, next_6_hours: period(6) },
          },
        ],
      },
    },
    null,
  );

  assert.deepEqual(
    forecast.steps.map((s) => [s.hours, s.precipitation]),
    [
      [3, 3],
      [1, 1],
      [6, 6],
    ],
  );
});

test("MET's double-s misspelling is read as light", () => {
  assert.deepEqual(
    weatherOfMetSymbol('lightssleetshowersandthunder_night').precipitation,
    { type: 'sleet', intensity: 'light', showers: true },
  );
});

test('hourly steps, the last of them 6-hourly, and the trailing instant dropped', () => {
  const instant = {
    details: { air_temperature: 1, wind_speed: 2, cloud_area_fraction: 50 },
  };

  const period = (code: string, mm: number) => ({
    summary: { symbol_code: code },
    details: { precipitation_amount: mm },
  });

  const forecast = forecastOfMet(
    {
      properties: {
        meta: { updated_at: '2026-11-20T09:00:00Z' },
        timeseries: [
          {
            time: '2026-11-20T09:00:00Z',
            data: {
              instant,
              next_1_hours: period('rain', 0.3),
              next_6_hours: period('rain', 2),
            },
          },
          {
            time: '2026-11-20T10:00:00Z',
            data: {
              instant,
              next_1_hours: period('cloudy', 0),
              next_6_hours: period('lightrain', 1.5),
            },
          },
          {
            time: '2026-11-20T16:00:00Z',
            data: { instant, next_6_hours: period('fog', 0) },
          },
          { time: '2026-11-20T22:00:00Z', data: { instant } },
        ],
      },
    },
    1500,
  );

  assert.deepEqual(
    forecast.steps.map((s) => [s.hours, s.precipitation, s.weather.sky]),
    [
      [1, 0.3, 'cloudy'],
      [6, 1.5, 'cloudy'],
      [6, 0, 'fog'],
    ],
  );

  assert.equal(forecast.elevation, 1500);
});
