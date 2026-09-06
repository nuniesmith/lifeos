import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	sql: vi.fn(),
	requireViewer: vi.fn(),
	householdToday: vi.fn(),
	agenda: vi.fn(),
	countTasks: vi.fn(),
	habitSummaries: vi.fn(),
	listDailyLogs: vi.fn(),
	listGoals: vi.fn(),
	listHabits: vi.fn(),
	listProjects: vi.fn(),
	listTasks: vi.fn(),
	upcomingImportantDates: vi.fn(),
	getWeather: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ sql: mocks.sql }));
vi.mock('$lib/server/viewer', () => ({ requireViewer: mocks.requireViewer }));
vi.mock('$lib/server/weather', () => ({ getWeather: mocks.getWeather }));
vi.mock('$lib/server/repositories/base', () => ({ householdToday: mocks.householdToday }));
vi.mock('$lib/server/repositories', async () => {
	const { daysBetween } = await import('$lib/server/repositories/dates');
	return { ...mocks, daysBetween, logHabit: vi.fn(), unlogHabit: vi.fn(), updateTask: vi.fn() };
});

import { load } from '../../src/routes/(app)/+page.server';

const viewer = { userId: 'viewer-id', householdId: 'household-id', role: 'member' };
const event = { locals: { user: { id: viewer.userId } } } as Parameters<typeof load>[0];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.requireViewer.mockResolvedValue(viewer);
	mocks.householdToday.mockResolvedValue('2026-09-05');
	mocks.sql.mockResolvedValue([{ timezone: 'America/Toronto' }]);
	mocks.agenda.mockResolvedValue({
		week: { start: '2026-08-31', end: '2026-09-06' },
		overdue: [],
		dueToday: [],
		dueThisWeek: []
	});
	for (const key of [
		'habitSummaries',
		'listDailyLogs',
		'listGoals',
		'listHabits',
		'listProjects',
		'listTasks',
		'upcomingImportantDates'
	] as const) {
		mocks[key].mockResolvedValue([]);
	}
	mocks.countTasks.mockResolvedValue(0);
	mocks.getWeather.mockResolvedValue({
		configured: false,
		status: 'not_configured',
		locationLabel: 'Local forecast',
		units: 'metric',
		current: null,
		updatedAt: null
	});
});

describe('home dashboard load', () => {
	it('uses the household date and the viewer-owned journal preview', async () => {
		const entry = { id: 'today-log', onDate: '2026-09-05', mood: 'Calm' };
		mocks.listDailyLogs.mockResolvedValue([entry, { id: 'past-log', onDate: '2026-09-04' }]);
		const data = await load(event);
		expect(data).toMatchObject({
			today: '2026-09-05',
			timezone: 'America/Toronto',
			dailyLog: entry
		});
		expect(mocks.listDailyLogs).toHaveBeenCalledWith(mocks.sql, viewer, {
			ownerUserId: viewer.userId,
			to: '2026-09-05',
			limit: 3
		});
		expect(mocks.agenda).toHaveBeenCalledWith(mocks.sql, viewer, {
			today: '2026-09-05',
			assignee: 'me'
		});
	});

	it('leaves today empty when only an earlier journal entry exists', async () => {
		mocks.listDailyLogs.mockResolvedValue([{ id: 'past-log', onDate: '2026-09-04' }]);
		expect(await load(event)).toMatchObject({ dailyLog: null });
	});

	it('reports the calendar window and discloses truncated results', async () => {
		mocks.listTasks.mockResolvedValue(
			Array.from({ length: 101 }, (_, index) => ({ id: `task-${index}` }))
		);
		const data = await load(event);
		expect(data).toMatchObject({
			calendarRange: { from: '2026-08-31', to: '2026-10-11' },
			calendarTruncated: true
		});
		if (!data) throw new Error('dashboard did not load');
		expect(data.calendarTasks).toHaveLength(100);
		expect(mocks.listTasks).toHaveBeenCalledWith(mocks.sql, viewer, {
			status: 'open',
			dueFrom: '2026-08-31',
			dueTo: '2026-10-11',
			order: 'due',
			limit: 101
		});
	});

	it('keeps the month grid correct across a year boundary', async () => {
		mocks.householdToday.mockResolvedValue('2027-01-01');
		expect(await load(event)).toMatchObject({
			calendarRange: { from: '2026-12-28', to: '2027-02-07' },
			calendarTruncated: false
		});
	});

	it('does not fetch dashboard records before authorization succeeds', async () => {
		mocks.requireViewer.mockRejectedValue(new Error('not authorized'));
		await expect(load(event)).rejects.toThrow('not authorized');
		expect(mocks.sql).not.toHaveBeenCalled();
		expect(mocks.listDailyLogs).not.toHaveBeenCalled();
		expect(mocks.listTasks).not.toHaveBeenCalled();
	});
});
