import { describe, expect, it } from 'vitest';
import { readDayLabel } from '$lib/read-dates';

describe('readDayLabel', () => {
	it('shows a stored day only as precisely as it is known', () => {
		expect(readDayLabel('2019-01-01', 'year')).toBe('2019');
		expect(readDayLabel('2019-05-01', 'month')).toBe('2019-05');
		expect(readDayLabel('2019-05-03', 'day')).toBe('2019-05-03');
	});
});
