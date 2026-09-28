import { describe, expect, it } from 'vitest';
import {
	groupDueMedications,
	isDueTodayOrJustTaken,
	latestBloodPressure,
	latestLabResults,
	latestReading,
	splitVisits,
	type DueMedication
} from '$lib/server/repositories/health-overview';
import type { LabMarker, LabResult, Medication, MedicalVisit } from '$lib/server/repositories';
import type { HealthMeasurement } from '$lib/server/repositories/health-measurements';

/**
 * The pure reductions inside `health-overview.ts`, exercised with plain
 * arrays and no database — the same split `chart.ts` and `format.ts` draw for
 * the measurements page, so the trickiest judgement calls (does a medication
 * belong on today's list? which row is "the latest"?) get a fast, direct
 * test rather than only an indirect one through `healthOverview` itself.
 */

const TODAY = '2026-09-25';

function medication(
	overrides: Partial<Medication> = {}
): Pick<Medication, 'id' | 'name' | 'dose' | 'unit' | 'brand' | 'scheduleKind' | 'runningLow'> {
	return {
		id: 'med-1',
		name: 'Lisinopril',
		dose: '10',
		unit: 'mg',
		brand: null,
		scheduleKind: 'daily_am',
		runningLow: false,
		...overrides
	};
}

function measurement(overrides: Partial<HealthMeasurement> = {}): HealthMeasurement {
	return {
		id: 'measurement-1',
		householdId: 'household-1',
		ownerUserId: 'owner-1',
		visibility: 'private',
		notionPageId: null,
		sourceRecordId: null,
		createdAt: new Date('2026-09-01T00:00:00Z'),
		updatedAt: new Date('2026-09-01T00:00:00Z'),
		createdBy: null,
		updatedBy: null,
		archivedAt: null,
		measuredAt: new Date('2026-09-01T08:00:00Z'),
		systolic: null,
		diastolic: null,
		bpContext: null,
		heartRate: null,
		glucose: null,
		glucoseUnit: null,
		glucoseContext: null,
		weight: null,
		weightUnit: null,
		qtInterval: null,
		notes: null,
		dailyLogId: null,
		...overrides
	};
}

function marker(overrides: Partial<LabMarker> = {}): LabMarker {
	return {
		id: 'marker-1',
		householdId: 'household-1',
		ownerUserId: null,
		visibility: 'household',
		notionPageId: null,
		sourceRecordId: null,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		createdBy: null,
		updatedBy: null,
		archivedAt: null,
		name: 'A1C',
		units: '%',
		referenceLow: 4,
		referenceHigh: 5.6,
		notes: null,
		...overrides
	};
}

function labResult(overrides: Partial<LabResult> = {}): LabResult {
	return {
		id: 'result-1',
		householdId: 'household-1',
		ownerUserId: null,
		visibility: 'household',
		notionPageId: null,
		sourceRecordId: null,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		createdBy: null,
		updatedBy: null,
		archivedAt: null,
		markerId: 'marker-1',
		resultDate: '2026-09-01',
		value: 5,
		notes: null,
		medicalVisitId: null,
		...overrides
	};
}

function visit(overrides: Partial<MedicalVisit> = {}): MedicalVisit {
	return {
		id: 'visit-1',
		householdId: 'household-1',
		ownerUserId: null,
		visibility: 'household',
		notionPageId: null,
		sourceRecordId: null,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		createdBy: null,
		updatedBy: null,
		archivedAt: null,
		reason: 'Check-up',
		visitAt: new Date('2026-09-25T14:00:00Z'),
		visitType: null,
		provider: null,
		location: null,
		amount: null,
		currency: 'CAD',
		paidBy: null,
		requirements: [],
		familyMember: null,
		notes: null,
		dailyLogId: null,
		providerPersonId: null,
		locationPlaceId: null,
		petId: null,
		...overrides
	};
}

describe('isDueTodayOrJustTaken', () => {
	it('is always true for a daily routine, whatever computeDueStatus says', () => {
		expect(isDueTodayOrJustTaken('daily_am', { isDueToday: false, lastTakenOn: null }, TODAY)).toBe(
			true
		);
		expect(
			isDueTodayOrJustTaken('daily_pm', { isDueToday: false, lastTakenOn: '2026-09-20' }, TODAY)
		).toBe(true);
	});

	it('is never true for an as-needed medication, even if logged today', () => {
		expect(
			isDueTodayOrJustTaken('as_needed', { isDueToday: false, lastTakenOn: TODAY }, TODAY)
		).toBe(false);
	});

	it('is true for a scheduled medication computeDueStatus says is due today', () => {
		expect(isDueTodayOrJustTaken('scheduled', { isDueToday: true, lastTakenOn: null }, TODAY)).toBe(
			true
		);
	});

	it('stays true once a scheduled medication is taken today, even though computeDueStatus would now say it is not due', () => {
		// The bug this guards: an interval schedule's `nextDueOn` is recomputed
		// from the just-logged dose, so `isDueToday` flips false in the same
		// request a dose is logged — without the `lastTakenOn` clause, ticking
		// a due medication would make it vanish instead of showing as done.
		expect(
			isDueTodayOrJustTaken('scheduled', { isDueToday: false, lastTakenOn: TODAY }, TODAY)
		).toBe(true);
	});

	it('is false for a scheduled medication neither due nor taken today', () => {
		expect(
			isDueTodayOrJustTaken('scheduled', { isDueToday: false, lastTakenOn: '2026-09-20' }, TODAY)
		).toBe(false);
	});
});

describe('groupDueMedications', () => {
	it('sorts daily_am/daily_pm into their own groups and scheduled-due into other', () => {
		const entries = [
			{
				medication: medication({ id: 'am', scheduleKind: 'daily_am' }),
				dueStatus: { isDueToday: true, lastTakenOn: null }
			},
			{
				medication: medication({ id: 'pm', scheduleKind: 'daily_pm' }),
				dueStatus: { isDueToday: true, lastTakenOn: null }
			},
			{
				medication: medication({ id: 'weekly', scheduleKind: 'scheduled' }),
				dueStatus: { isDueToday: true, lastTakenOn: null }
			}
		];

		const grouped = groupDueMedications(entries, TODAY);
		expect(grouped.am.map((m) => m.id)).toEqual(['am']);
		expect(grouped.pm.map((m) => m.id)).toEqual(['pm']);
		expect(grouped.other.map((m) => m.id)).toEqual(['weekly']);
	});

	it('excludes as-needed and not-due-today medications entirely', () => {
		const entries = [
			{
				medication: medication({ id: 'prn', scheduleKind: 'as_needed' }),
				dueStatus: { isDueToday: false, lastTakenOn: null }
			},
			{
				medication: medication({ id: 'not-yet', scheduleKind: 'scheduled' }),
				dueStatus: { isDueToday: false, lastTakenOn: '2026-09-01' }
			}
		];

		const grouped = groupDueMedications(entries, TODAY);
		expect([...grouped.am, ...grouped.pm, ...grouped.other]).toEqual([]);
		expect(grouped.dueCount).toBe(0);
		expect(grouped.takenCount).toBe(0);
	});

	it('tallies dueCount and takenCount separately, and carries the running-low flag', () => {
		const entries = [
			{
				medication: medication({ id: 'due', runningLow: true }),
				dueStatus: { isDueToday: true, lastTakenOn: null }
			},
			{
				medication: medication({ id: 'taken' }),
				dueStatus: { isDueToday: false, lastTakenOn: TODAY }
			}
		];

		const grouped = groupDueMedications(entries, TODAY);
		expect(grouped.dueCount).toBe(1);
		expect(grouped.takenCount).toBe(1);
		const due: DueMedication = grouped.am.find((m) => m.id === 'due')!;
		expect(due.runningLow).toBe(true);
		expect(due.takenToday).toBe(false);
		const taken: DueMedication = grouped.am.find((m) => m.id === 'taken')!;
		expect(taken.takenToday).toBe(true);
	});
});

describe('latestReading', () => {
	it('takes the unit from the same row as the value, never from a later one', () => {
		const rows = [
			measurement({
				measuredAt: new Date('2026-09-20T00:00:00Z'),
				weight: 154.3,
				weightUnit: null
			}),
			measurement({ measuredAt: new Date('2026-09-10T00:00:00Z'), weight: 70, weightUnit: 'kg' })
		];
		// The newest weight recorded no unit: it is shown without one, not with
		// the older row's "kg", which would state a reading that never happened.
		expect(
			latestReading(
				rows,
				(r) => r.weight,
				(r) => r.weightUnit
			)
		).toEqual({
			value: 154.3,
			measuredAt: new Date('2026-09-20T00:00:00Z'),
			unit: null
		});
		expect(
			latestReading(
				rows.slice(1),
				(r) => r.weight,
				(r) => r.weightUnit
			)
		).toEqual({
			value: 70,
			measuredAt: new Date('2026-09-10T00:00:00Z'),
			unit: 'kg'
		});
	});

	it('returns the first row (most-recent-first) where the picked field is set', () => {
		const rows = [
			measurement({ measuredAt: new Date('2026-09-20T00:00:00Z'), heartRate: null }),
			measurement({ measuredAt: new Date('2026-09-10T00:00:00Z'), heartRate: 72 }),
			measurement({ measuredAt: new Date('2026-09-01T00:00:00Z'), heartRate: 68 })
		];
		expect(latestReading(rows, (r) => r.heartRate)).toEqual({
			value: 72,
			measuredAt: new Date('2026-09-10T00:00:00Z')
		});
	});

	it('returns null when no row has that reading', () => {
		expect(latestReading([measurement({ heartRate: null })], (r) => r.heartRate)).toBeNull();
		expect(latestReading([], (r) => r.heartRate)).toBeNull();
	});
});

describe('latestBloodPressure', () => {
	it('takes both numbers from the same, most recent row -- never mixing rows', () => {
		const rows = [
			measurement({ measuredAt: new Date('2026-09-20T00:00:00Z'), systolic: 130, diastolic: 82 }),
			measurement({ measuredAt: new Date('2026-09-10T00:00:00Z'), systolic: 118, diastolic: 76 })
		];
		expect(latestBloodPressure(rows)).toEqual({
			systolic: 130,
			diastolic: 82,
			measuredAt: new Date('2026-09-20T00:00:00Z')
		});
	});

	it('accepts a row with only one half recorded', () => {
		const rows = [
			measurement({ measuredAt: new Date('2026-09-20T00:00:00Z'), systolic: 130, diastolic: null })
		];
		expect(latestBloodPressure(rows)).toEqual({
			systolic: 130,
			diastolic: null,
			measuredAt: new Date('2026-09-20T00:00:00Z')
		});
	});

	it('returns null when no row names either half', () => {
		expect(latestBloodPressure([measurement()])).toBeNull();
	});
});

describe('latestLabResults', () => {
	it('picks each marker’s most recent result and flags it against that marker’s range', () => {
		const markers = [
			marker({ id: 'a1c', name: 'A1C', referenceLow: 4, referenceHigh: 5.6 }),
			marker({ id: 'ldl', name: 'LDL', referenceLow: null, referenceHigh: 3.4 })
		];
		// Most-recent-first, as listLabResults(order: 'desc') returns.
		const results = [
			labResult({ markerId: 'a1c', resultDate: '2026-09-10', value: 6.1 }),
			labResult({ markerId: 'ldl', resultDate: '2026-09-05', value: 4.0 }),
			labResult({ markerId: 'a1c', resultDate: '2026-01-01', value: 5.0 })
		];

		const items = latestLabResults(markers, results);
		// units: '%' is the marker() factory's own default, carried through
		// unchanged -- latestLabResults never invents or drops a unit.
		expect(items).toEqual([
			{
				markerId: 'a1c',
				markerName: 'A1C',
				units: '%',
				value: 6.1,
				resultDate: '2026-09-10',
				status: 'high'
			},
			{
				markerId: 'ldl',
				markerName: 'LDL',
				units: '%',
				value: 4.0,
				resultDate: '2026-09-05',
				status: 'high'
			}
		]);
	});

	it('omits a marker with no live result', () => {
		const markers = [marker({ id: 'never-drawn' })];
		expect(latestLabResults(markers, [])).toEqual([]);
	});
});

describe('splitVisits', () => {
	it('finds the most recent past visit and the next upcoming one', () => {
		// Real MedicalVisit records (via the factory), not bare {visitAt}
		// stand-ins -- `splitVisits` is typed to accept either, and this proves
		// the wider shape actually satisfies it.
		const visits = [
			visit({ id: 'past-1', reason: 'Old check-up', visitAt: new Date('2026-01-01T00:00:00Z') }),
			visit({ id: 'past-2', reason: 'Follow up', visitAt: new Date('2026-06-01T00:00:00Z') }),
			visit({ id: 'future', reason: 'Annual', visitAt: new Date('2026-12-01T00:00:00Z') })
		];
		const now = new Date('2026-09-25T00:00:00Z').getTime();
		expect(splitVisits(visits, now)).toEqual({ mostRecent: 1, next: 2 });
	});

	it('treats a visit exactly at `now` as upcoming, matching the visits page’s own `>=`', () => {
		const at = new Date('2026-09-25T14:00:00Z');
		expect(splitVisits([{ visitAt: at }], at.getTime())).toEqual({ mostRecent: null, next: 0 });
	});

	it('has no most-recent when every visit is in the future', () => {
		const visits = [{ visitAt: new Date('2026-12-01T00:00:00Z') }];
		expect(splitVisits(visits, new Date('2026-09-25T00:00:00Z').getTime())).toEqual({
			mostRecent: null,
			next: 0
		});
	});

	it('has no next when every visit is in the past', () => {
		const visits = [{ visitAt: new Date('2026-01-01T00:00:00Z') }];
		expect(splitVisits(visits, new Date('2026-09-25T00:00:00Z').getTime())).toEqual({
			mostRecent: 0,
			next: null
		});
	});

	it('returns both null for no visits at all', () => {
		expect(splitVisits([], Date.now())).toEqual({ mostRecent: null, next: null });
	});
});
