import z from 'zod';

// The response is our own, so the provider behind it can change without a
// client release.

export const WeatherSchema = z
  .strictObject({
    sky: z.enum(['clear', 'fair', 'partlyCloudy', 'cloudy', 'fog']),
    precipitation: z
      .strictObject({
        type: z.enum(['rain', 'sleet', 'snow']),
        intensity: z.enum(['light', 'moderate', 'heavy']),
        showers: z.boolean(),
      })
      .nullable(),
    thunder: z.boolean(),
    day: z.boolean(),
  })
  .meta({ id: 'Weather' });

export type Weather = z.infer<typeof WeatherSchema>;

export const ForecastStepSchema = z
  .strictObject({
    time: z.iso.datetime(),
    hours: z.int().positive().meta({
      description:
        'length of the period that `weather` and `precipitation` describe, starting at `time`',
    }),
    temperature: z.number().meta({ description: '°C at `time`' }),
    apparentTemperature: z
      .number()
      .nullable()
      .meta({ description: 'felt °C at `time`' }),
    windSpeed: z.number().meta({ description: 'm/s at `time`' }),
    windGust: z
      .number()
      .nullable()
      .meta({ description: 'm/s, the strongest over the period' }),
    windDirection: z
      .number()
      .nullable()
      .meta({ description: 'degrees the wind blows from' }),
    cloudCover: z.number().meta({ description: '%' }),
    cloudCoverLow: z.number().nullable().meta({ description: '% below 3 km' }),
    cloudCoverMid: z.number().nullable().meta({ description: '% at 3–8 km' }),
    cloudCoverHigh: z.number().nullable().meta({ description: '% above 8 km' }),
    precipitation: z.number().meta({ description: 'mm over the period' }),
    precipitationProbability: z
      .number()
      .nullable()
      .meta({ description: '% over the period, where the provider has it' }),
    rain: z
      .number()
      .nullable()
      .meta({ description: 'mm of rain and showers over the period' }),
    snowfall: z
      .number()
      .nullable()
      .meta({ description: 'cm of fresh snow over the period' }),
    snowDepth: z
      .number()
      .nullable()
      .meta({ description: 'cm of snow on the ground at `time`' }),
    freezingLevel: z
      .number()
      .nullable()
      .meta({ description: 'metres above sea level of 0 °C at `time`' }),
    cape: z.number().nullable().meta({
      description: 'J/kg at `time`: the energy for thunderstorms',
    }),
    sunshine: z
      .number()
      .nullable()
      .meta({ description: 'minutes of sunshine over the period' }),
    uvIndex: z.number().nullable().meta({ description: 'at `time`' }),
    visibility: z.number().nullable().meta({ description: 'metres at `time`' }),
    snowLine: z.number().nullable().meta({
      description:
        'metres above sea level from which it falls as snow, at `time`',
    }),
    humidity: z
      .number()
      .nullable()
      .meta({ description: '% relative humidity at `time`' }),
    weather: WeatherSchema,
  })
  .meta({ id: 'ForecastStep' });

export type ForecastStep = z.infer<typeof ForecastStepSchema>;

export const ForecastSchema = z
  .strictObject({
    updatedAt: z.iso
      .datetime()
      .meta({ description: 'when the forecast was fetched' }),
    elevation: z
      .number()
      .nullable()
      .meta({ description: 'metres the temperature is adjusted to' }),
    steps: ForecastStepSchema.array(),
    sun: z
      .strictObject({
        sunrise: z.iso.datetime().nullable(),
        sunset: z.iso.datetime().nullable(),
      })
      .array()
      .meta({
        description: 'by UTC day; null in a polar day or night',
      }),
    attribution: z.strictObject({ name: z.string(), url: z.string() }),
  })
  .meta({ id: 'Forecast' });

export type Forecast = z.infer<typeof ForecastSchema>;

/** The hourly variables asked for, each read by its name below. */
export const OPEN_METEO_HOURLY = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'precipitation_probability',
  'weather_code',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'snow_depth',
  'freezing_level_height',
  'cape',
  'sunshine_duration',
  'uv_index',
  'visibility',
  'is_day',
  'snowfall_height',
  'relative_humidity_2m',
] as const;

/** Computed rather than forecast: they cost no data. */
export const OPEN_METEO_DAILY = ['sunrise', 'sunset'] as const;

const series = z.array(z.number().nullable());

const hourlySeries = Object.fromEntries(
  OPEN_METEO_HOURLY.map((name) => [name, series]),
) as Record<(typeof OPEN_METEO_HOURLY)[number], typeof series>;

export const OpenMeteoResponseSchema = z.object({
  elevation: z.number(),
  hourly: z.object({ time: z.array(z.number()), ...hourlySeries }),
  daily: z
    .object({ time: z.array(z.number()), sunrise: series, sunset: series })
    .optional(),
});

export type OpenMeteoResponse = z.infer<typeof OpenMeteoResponseSchema>;

type Intensity = NonNullable<Weather['precipitation']>['intensity'];

const LMH: Intensity[] = ['light', 'moderate', 'heavy'];

type Phase = 'rain' | 'sleet' | 'snow';

/**
 * A WMO weather code as our `Weather`; `phase`, from the hour's amounts, says
 * what falls where the code only says that something does.
 */
export function weatherOfWmoCode(
  code: number,
  day: boolean,
  phase?: Phase,
): Weather {
  const precipitation = (
    type: Phase,
    intensity: Intensity,
    showers = false,
    thunder = false,
  ): Weather => ({
    sky: showers ? 'partlyCloudy' : 'cloudy',
    precipitation: {
      // Freezing rain stays sleet whatever the amounts.
      type: type === 'sleet' ? type : (phase ?? type),
      intensity,
      showers,
    },
    thunder,
    day,
  });

  const sky = (sky: Weather['sky']): Weather => ({
    sky,
    precipitation: null,
    thunder: false,
    day,
  });

  switch (code) {
    case 0:
      return sky('clear');
    case 1:
      return sky('fair');
    case 2:
      return sky('partlyCloudy');
    case 45:
    case 48:
      return sky('fog');
    // Drizzle.
    case 51:
    case 53:
      return precipitation('rain', 'light');
    case 55:
      return precipitation('rain', 'moderate');
    // Freezing drizzle and rain.
    // TODO a type of its own: glaze ice is no sleet, but no client shows it yet.
    case 56:
    case 66:
      return precipitation('sleet', 'light');
    case 57:
    case 67:
      return precipitation('sleet', 'heavy');
    case 61:
    case 63:
    case 65:
      return precipitation('rain', LMH[(code - 61) / 2]!);
    case 71:
    case 73:
    case 75:
      return precipitation('snow', LMH[(code - 71) / 2]!);
    // Snow grains.
    case 77:
      return precipitation('snow', 'light');
    case 80:
    case 81:
    case 82:
      return precipitation('rain', LMH[code - 80]!, true);
    case 85:
      return precipitation('snow', 'light', true);
    case 86:
      return precipitation('snow', 'heavy', true);
    case 95:
      return precipitation('rain', 'moderate', true, true);
    // With hail.
    case 96:
    case 99:
      return precipitation('rain', 'heavy', true, true);
    default:
      return sky('cloudy');
  }
}

/**
 * What the hour's amounts say falls: sleet only where each part is at least a
 * quarter, not a trace of snow in rain; nothing where nothing does.
 */
function phaseOf(
  rain: number | null,
  snowfall: number | null,
): Phase | undefined {
  // Open-Meteo's snowfall is 0.7 cm per mm of water.
  const snowWater = (snowfall ?? 0) / 0.7;

  const wet = rain ?? 0;

  const total = wet + snowWater;

  if (total <= 0) {
    return undefined;
  }

  return Math.min(wet, snowWater) >= total / 4
    ? 'sleet'
    : snowWater > wet
      ? 'snow'
      : 'rain';
}

/** WMO 0 clear to 3 overcast, by cloud cover in %. */
function skyCode(cloudCover: number): number {
  return cloudCover < 20 ? 0 : cloudCover < 50 ? 1 : cloudCover < 80 ? 2 : 3;
}

function isoOfUnix(t: number | null | undefined): string | null {
  return t == null ? null : new Date(t * 1000).toISOString();
}

/**
 * Hourly steps from `now`'s hour. A sum, maximum or code is for the hour
 * before its time, so a step's period comes from the next time.
 */
export function forecastOfOpenMeteo(
  om: OpenMeteoResponse,
  elevation: number | null,
  now: number,
): Forecast {
  const h = om.hourly;

  const steps: ForecastStep[] = [];

  for (const [i, t] of h.time.entries()) {
    const time = t * 1000;

    const next = i + 1;

    if (next >= h.time.length || time + 3_600_000 <= now) {
      continue;
    }

    const temperature = h.temperature_2m[i];

    const windSpeed = h.wind_speed_10m[i];

    // The code at `next` weighs the hour's precipitation but the sky only at
    // its end; a bare sky is taken from the cloud cover at the step's start,
    // as its cloud layers are, by Open-Meteo's own thresholds.
    const nextCode = h.weather_code[next];

    const cloudCover = h.cloud_cover[i];

    const code =
      nextCode != null && nextCode <= 3 && cloudCover != null
        ? skyCode(cloudCover)
        : nextCode;

    // Past the reach of every model.
    if (temperature == null || windSpeed == null || code == null) {
      continue;
    }

    const rain =
      h.rain[next] == null && h.showers[next] == null
        ? null
        : (h.rain[next] ?? 0) + (h.showers[next] ?? 0);

    const snowfall = h.snowfall[next] ?? null;

    const snowDepth = h.snow_depth[i];

    const sunshine = h.sunshine_duration[next];

    steps.push({
      time: new Date(time).toISOString(),
      hours: 1,
      temperature,
      apparentTemperature: h.apparent_temperature[i] ?? null,
      windSpeed,
      windGust: h.wind_gusts_10m[next] ?? null,
      windDirection: h.wind_direction_10m[i] ?? null,
      cloudCover: cloudCover ?? 0,
      cloudCoverLow: h.cloud_cover_low[i] ?? null,
      cloudCoverMid: h.cloud_cover_mid[i] ?? null,
      cloudCoverHigh: h.cloud_cover_high[i] ?? null,
      precipitation: h.precipitation[next] ?? 0,
      precipitationProbability: h.precipitation_probability[next] ?? null,
      rain,
      snowfall,
      snowDepth: snowDepth == null ? null : Math.round(snowDepth * 100),
      freezingLevel: h.freezing_level_height[i] ?? null,
      snowLine: h.snowfall_height[i] ?? null,
      humidity: h.relative_humidity_2m[i] ?? null,
      cape: h.cape[i] ?? null,
      sunshine: sunshine == null ? null : Math.round(sunshine / 60),
      uvIndex: h.uv_index[i] ?? null,
      visibility: h.visibility[i] ?? null,
      weather: weatherOfWmoCode(
        code,
        h.is_day[i] !== 0,
        phaseOf(rain, snowfall),
      ),
    });
  }

  return {
    // TODO the models' run time: a stalled sync still reads as fresh.
    updatedAt: new Date(now).toISOString(),
    elevation: elevation ?? Math.round(om.elevation),
    steps,
    sun: (om.daily?.time ?? []).map((_, i) => {
      const rise = om.daily?.sunrise[i];

      const set = om.daily?.sunset[i];

      // A polar night comes as both at midnight, a polar day as a whole day.
      const polar =
        rise == null || set == null || set - rise <= 0 || set - rise >= 86_400;

      return polar
        ? { sunrise: null, sunset: null }
        : { sunrise: isoOfUnix(rise), sunset: isoOfUnix(set) };
    }),
    // The data's CC BY 4.0 asks for the credit and the licence.
    attribution: {
      name: 'Open-Meteo (CC BY 4.0)',
      url: 'https://open-meteo.com/en/license',
    },
  };
}
