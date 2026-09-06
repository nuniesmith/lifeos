import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	sql: vi.fn(),
	requireViewer: vi.fn(),
	householdToday: vi.fn(),
	listTasks: vi.fn(),
	upcomingImportantDates: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ sql: mocks.sql }));
vi.mock('$lib/server/viewer', () => ({ requireViewer: mocks.requireViewer }));
vi.mock('$lib/server/repositories/base', () => ({ householdToday: mocks.householdToday }));
vi.mock('$lib/server/repositories', () => ({
	TASK_STATUSES: ['todo', 'in_progress', 'blocked', 'done', 'dropped'],
	listTasks: mocks.listTasks,
	upcomingImportantDates: mocks.upcomingImportantDates,
	daysBetween: (from: string, to: string) =>
		Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}));

import { load } from '../../src/routes/(app)/calendar/+page.server';

const viewer = { userId: 'viewer-id', householdId: 'household-id', role: 'member' };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireViewer.mockResolvedValue(viewer);
	mocks.householdToday.mockResolvedValue('2026-09-05');
	mocks.listTasks.mockResolvedValue([]);
	mocks.upcomingImportantDates.mockResolvedValue([]);
});

describe('calendar page load', () => {
	it('loads the requested month from the server range', async () => {
		const data = await load({
			locals: { user: { id: viewer.userId } },
			url: new URL('http://lifeos.test/calendar?month=2026-10')
		} as Parameters<typeof load>[0]);

		expect(data).toMatchObject({
			today: '2026-09-05',
			month: '2026-10',
			range: { from: '2026-09-28', to: '2026-11-08' },
			tasks: [],
			dates: []
		});
		expect(mocks.listTasks).toHaveBeenCalledWith(mocks.sql, viewer, {
			status: ['todo', 'in_progress', 'blocked', 'done', 'dropped'],
			dueFrom: '2026-09-28',
			dueTo: '2026-11-08',
			order: 'due',
			limit: 500
		});
	});

	it('falls back to the household month for an invalid query', async () => {
		const data = await load({
			locals: { user: { id: viewer.userId } },
			url: new URL('http://lifeos.test/calendar?month=not-a-month')
		} as Parameters<typeof load>[0]);

		if (!data) throw new Error('calendar did not load');
		expect(data.month).toBe('2026-09');
	});
});
