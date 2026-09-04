import { describe, expect, it } from 'vitest';
import { worst, type Check } from '$lib/server/health/status';

const c = (name: string, status: Check['status']): Check => ({ name, status });

describe('readiness aggregation', () => {
	it('is ok only when every check is ok', () => {
		expect(worst([c('a', 'ok'), c('b', 'ok')])).toBe('ok');
	});

	it('degrades when any check is degraded', () => {
		expect(worst([c('a', 'ok'), c('b', 'degraded')])).toBe('degraded');
	});

	it('fails when any check fails, even alongside degraded ones', () => {
		expect(worst([c('a', 'degraded'), c('b', 'fail'), c('c', 'ok')])).toBe('fail');
	});

	it('treats a failure as worse than a degradation regardless of order', () => {
		expect(worst([c('a', 'fail'), c('b', 'degraded')])).toBe('fail');
		expect(worst([c('a', 'degraded'), c('b', 'fail')])).toBe('fail');
	});

	it('is ok for an empty set, so a check list that failed to populate cannot silently fail the deploy', () => {
		expect(worst([])).toBe('ok');
	});
});
