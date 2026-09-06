import { describe, expect, it } from 'vitest';
import { weatherCodeInfo } from '../../src/lib/server/weather';

describe('weather code presentation', () => {
	it('maps clear day and night distinctly', () => {
		expect(weatherCodeInfo(0, true)).toEqual({ label: 'Clear sky', icon: '☀️' });
		expect(weatherCodeInfo(0, false)).toEqual({ label: 'Clear night', icon: '🌙' });
	});

	it('covers common precipitation codes', () => {
		expect(weatherCodeInfo(63).label).toBe('Rain');
		expect(weatherCodeInfo(73).label).toBe('Snow');
		expect(weatherCodeInfo(95).label).toBe('Thunderstorms');
	});
});
