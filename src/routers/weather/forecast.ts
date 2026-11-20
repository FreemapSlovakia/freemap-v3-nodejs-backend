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
    windSpeed: z.number().meta({ description: 'm/s at `time`' }),
    windGust: z.number().nullable().meta({ description: 'm/s at `time`' }),
    windDirection: z
      .number()
      .nullable()
      .meta({ description: 'degrees the wind blows from' }),
    cloudCover: z.number().meta({ description: '%' }),
    precipitation: z.number().meta({ description: 'mm over the period' }),
    precipitationProbability: z
      .number()
      .nullable()
      .meta({ description: '% over the period, where the provider has it' }),
    weather: WeatherSchema,
  })
  .meta({ id: 'ForecastStep' });

export type ForecastStep = z.infer<typeof ForecastStepSchema>;

export const ForecastSchema = z
  .strictObject({
    updatedAt: z.iso.datetime(),
    elevation: z
      .number()
      .nullable()
      .meta({ description: 'metres the temperature is adjusted to' }),
    steps: ForecastStepSchema.array(),
    attribution: z.strictObject({ name: z.string(), url: z.string() }),
  })
  .meta({ id: 'Forecast' });

export type Forecast = z.infer<typeof ForecastSchema>;

const MetPeriodSchema = z.object({
  summary: z.object({ symbol_code: z.string() }),
  details: z.object({
    precipitation_amount: z.number().optional(),
    probability_of_precipitation: z.number().optional(),
  }),
});

export const MetResponseSchema = z.object({
  properties: z.object({
    meta: z.object({ updated_at: z.string() }),
    timeseries: z
      .object({
        time: z.string(),
        data: z.object({
          instant: z.object({
            details: z.object({
              air_temperature: z.number(),
              wind_speed: z.number(),
              wind_speed_of_gust: z.number().optional(),
              wind_from_direction: z.number().optional(),
              cloud_area_fraction: z.number(),
            }),
          }),
          next_1_hours: MetPeriodSchema.optional(),
          next_6_hours: MetPeriodSchema.optional(),
        }),
      })
      .array(),
  }),
});

// MET spells some codes with a double s (`lightssleetshowersandthunder`).
const PRECIPITATION_RE =
  /^(light|heavy)?s?(rain|sleet|snow)(showers)?(andthunder)?$/;

const SKIES: Record<string, Weather['sky']> = {
  clearsky: 'clear',
  fair: 'fair',
  partlycloudy: 'partlyCloudy',
  cloudy: 'cloudy',
  fog: 'fog',
};

/** A MET `symbol_code`, such as `lightrainshowers_day`, as our `Weather`. */
export function weatherOfMetSymbol(code: string): Weather {
  const [base = '', variant] = code.split('_');

  const day = variant !== 'night';

  const sky = SKIES[base];

  if (sky) {
    return { sky, precipitation: null, thunder: false, day };
  }

  const m = PRECIPITATION_RE.exec(base);

  // TODO log an unknown code once, so a new MET symbol gets noticed.
  if (!m) {
    return { sky: 'cloudy', precipitation: null, thunder: false, day };
  }

  const [, intensity, type, showers, thunder] = m;

  return {
    sky: showers ? 'partlyCloudy' : 'cloudy',
    precipitation: {
      type: type as 'rain' | 'sleet' | 'snow',
      intensity:
        intensity === 'light' || intensity === 'heavy' ? intensity : 'moderate',
      showers: Boolean(showers),
    },
    thunder: Boolean(thunder),
    day,
  };
}

/** MET's hourly steps, then its 6-hour ones; the last instant, with no period, is dropped. */
export function forecastOfMet(
  met: z.infer<typeof MetResponseSchema>,
  elevation: number | null,
): Forecast {
  const steps: ForecastStep[] = [];

  const { timeseries } = met.properties;

  for (const [i, { time, data }] of timeseries.entries()) {
    const next = timeseries[i + 1];

    const gapHours = next
      ? (Date.parse(next.time) - Date.parse(time)) / 3_600_000
      : Infinity;

    // A step lasts until the next instant: an hour from the hourly period, a
    // longer gap from the 6-hour one, cut to the gap so no hours overlap or go
    // missing, its precipitation in proportion.
    const hourly = data.next_1_hours && (gapHours <= 1 || !data.next_6_hours);

    const period = hourly ? data.next_1_hours : data.next_6_hours;

    if (!period) {
      continue;
    }

    const hours = hourly ? 1 : Math.min(6, gapHours);

    const instant = data.instant.details;

    steps.push({
      time,
      hours,
      temperature: instant.air_temperature,
      windSpeed: instant.wind_speed,
      windGust: instant.wind_speed_of_gust ?? null,
      windDirection: instant.wind_from_direction ?? null,
      cloudCover: instant.cloud_area_fraction,
      precipitation:
        ((period.details.precipitation_amount ?? 0) * (hourly ? 1 : hours)) /
        (hourly ? 1 : 6),
      precipitationProbability:
        period.details.probability_of_precipitation ?? null,
      weather: weatherOfMetSymbol(period.summary.symbol_code),
    });
  }

  return {
    updatedAt: met.properties.meta.updated_at,
    elevation,
    steps,
    attribution: { name: 'MET Norway', url: 'https://www.met.no/en' },
  };
}
