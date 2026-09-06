export interface WeatherCurrent {
	temperature: number;
	feelsLike: number;
	windSpeed: number;
	weatherCode: number;
	isDay: boolean;
	label: string;
	icon: string;
}

export interface WeatherResult {
	configured: boolean;
	status: 'ok' | 'unavailable' | 'not_configured';
	locationLabel: string;
	units: 'metric' | 'imperial';
	current: WeatherCurrent | null;
	updatedAt: string | null;
}

const cache = new Map<string, { expiresAt: number; value: WeatherResult }>();
const CACHE_MS = 15 * 60 * 1000;

/** WMO weather interpretation used by the Open-Meteo forecast response. */
export function weatherCodeInfo(code: number, isDay = true): { label: string; icon: string } {
	if (code === 0) return { label: isDay ? 'Clear sky' : 'Clear night', icon: isDay ? '☀️' : '🌙' };
	if (code === 1) return { label: 'Mostly clear', icon: isDay ? '🌤️' : '🌙' };
	if (code === 2) return { label: 'Partly cloudy', icon: '⛅' };
	if (code === 3) return { label: 'Overcast', icon: '☁️' };
	if ([45, 48].includes(code)) return { label: 'Foggy', icon: '🌫️' };
	if ([51, 53, 55, 56, 57].includes(code)) return { label: 'Drizzle', icon: '🌦️' };
	if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: 'Rain', icon: '🌧️' };
	if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: 'Snow', icon: '🌨️' };
	if ([95, 96, 99].includes(code)) return { label: 'Thunderstorms', icon: '⛈️' };
	return { label: 'Changing skies', icon: '🌥️' };
}

const finiteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

function notConfigured(
	label = 'Local forecast',
	units: 'metric' | 'imperial' = 'metric'
): WeatherResult {
	return {
		configured: false,
		status: 'not_configured',
		locationLabel: label,
		units,
		current: null,
		updatedAt: null
	};
}

/**
 * Fetches a short-lived, server-side forecast. The coordinates are supplied
 * by deployment configuration rather than browser geolocation, so a private
 * household location is never sent from the browser as part of the request.
 */
export async function getWeather(timezone: string): Promise<WeatherResult> {
	// Keep the presentation mapper importable in unit tests and during build
	// analysis without requiring runtime database configuration.
	const { env } = await import('./env');
	if (env.LIFEOS_WEATHER_LATITUDE === undefined || env.LIFEOS_WEATHER_LONGITUDE === undefined) {
		return notConfigured(env.LIFEOS_WEATHER_LABEL, env.LIFEOS_WEATHER_UNITS);
	}

	const units = env.LIFEOS_WEATHER_UNITS;
	const key = `${env.LIFEOS_WEATHER_LATITUDE},${env.LIFEOS_WEATHER_LONGITUDE},${timezone},${units}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	const resultBase = {
		configured: true,
		locationLabel: env.LIFEOS_WEATHER_LABEL,
		units,
		current: null,
		updatedAt: null
	} as const;

	try {
		const url = new URL('https://api.open-meteo.com/v1/forecast');
		url.searchParams.set('latitude', String(env.LIFEOS_WEATHER_LATITUDE));
		url.searchParams.set('longitude', String(env.LIFEOS_WEATHER_LONGITUDE));
		url.searchParams.set(
			'current',
			'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m'
		);
		url.searchParams.set('timezone', timezone);
		if (units === 'imperial') {
			url.searchParams.set('temperature_unit', 'fahrenheit');
			url.searchParams.set('wind_speed_unit', 'mph');
		}

		const response = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(4_000)
		});
		if (!response.ok) throw new Error(`weather provider returned ${response.status}`);
		const payload: unknown = await response.json();
		const current = (payload as { current?: Record<string, unknown> }).current;
		const temperature = current?.temperature_2m;
		const feelsLike = current?.apparent_temperature;
		const weatherCode = current?.weather_code;
		const isDay = current?.is_day;
		const windSpeed = current?.wind_speed_10m;
		if (
			!current ||
			!finiteNumber(temperature) ||
			!finiteNumber(feelsLike) ||
			!finiteNumber(weatherCode) ||
			typeof isDay !== 'number' ||
			!finiteNumber(windSpeed)
		) {
			throw new Error('weather provider returned an incomplete current forecast');
		}

		const day = isDay === 1;
		const info = weatherCodeInfo(weatherCode, day);
		const value: WeatherResult = {
			...resultBase,
			status: 'ok',
			current: {
				temperature,
				feelsLike,
				windSpeed,
				weatherCode,
				isDay: day,
				...info
			},
			updatedAt: new Date().toISOString()
		};
		cache.set(key, { expiresAt: Date.now() + CACHE_MS, value });
		return value;
	} catch {
		return { ...resultBase, status: 'unavailable' };
	}
}
