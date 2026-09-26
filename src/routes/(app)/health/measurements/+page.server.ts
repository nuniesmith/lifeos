import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	createHealthMeasurement,
	listHealthMeasurements,
	setHealthMeasurementArchived,
	updateHealthMeasurement
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import { DEFAULT_GLUCOSE_UNIT, DEFAULT_WEIGHT_UNIT } from '$lib/units';
import type { Actions, PageServerLoad } from './$types';
import { toLocalInput } from './format';

/**
 * Health Measurements.
 *
 * The importer and the "add a reading" form both write to one table
 * (migration 0019), so this page is the whole feature: add, edit, delete,
 * and the charts and recent list that make the readings worth having kept.
 */

/** Readings enough to draw a meaningful trend without paging. */
const HISTORY_LIMIT = 300;

const readingFields = (form: FormData) => ({
	measuredAt: form.get('measuredAt'),
	systolic: form.get('systolic'),
	diastolic: form.get('diastolic'),
	bpContext: form.get('bpContext'),
	heartRate: form.get('heartRate'),
	glucose: form.get('glucose'),
	glucoseUnit: form.get('glucoseUnit'),
	glucoseContext: form.get('glucoseContext'),
	weight: form.get('weight'),
	weightUnit: form.get('weightUnit'),
	qtInterval: form.get('qtInterval'),
	notes: form.get('notes')
});

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);

	const [readings, household] = await Promise.all([
		listHealthMeasurements(sql, viewer, { limit: HISTORY_LIMIT }),
		sql<{ timezone: string }[]>`
			select timezone from households where id = ${viewer.householdId}::uuid
		`
	]);
	const timezone = household[0]?.timezone ?? 'America/Toronto';
	const own = readings.filter((r) => r.ownerUserId === viewer.userId);

	return {
		// The datetime-local input needs the household's own wall clock, not
		// whichever zone the server process happens to be running in.
		readings: readings.map((r) => ({
			...r,
			measuredAtLocal: toLocalInput(r.measuredAt, timezone)
		})),
		defaultMeasuredAt: toLocalInput(new Date(), timezone),
		// A new reading is offered in the unit this person used last, so someone
		// who weighs in lb is never quietly defaulted back to kg between two
		// readings. `readings` is most recent first. Only the viewer's own rows
		// that recorded a unit count: a reading the other member shared says
		// nothing about which unit this person uses, and neither does one
		// imported without a unit.
		defaultUnits: {
			glucose: own.find((r) => r.glucoseUnit !== null)?.glucoseUnit ?? DEFAULT_GLUCOSE_UNIT,
			weight: own.find((r) => r.weightUnit !== null)?.weightUnit ?? DEFAULT_WEIGHT_UNIT
		}
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createHealthMeasurement(sql, viewer, readingFields(form));
		if (!result.ok) {
			return fail(result.reason === 'invalid' ? 400 : 404, {
				action: 'create' as const,
				error: result.reason === 'invalid' ? result.message : 'Could not find that daily log.'
			});
		}
		return { action: 'create' as const, savedId: result.record.id };
	},

	update: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const expectedRaw = form.get('expectedUpdatedAt');

		const result = await updateHealthMeasurement(
			sql,
			viewer,
			id,
			readingFields(form),
			expectedRaw ? String(expectedRaw) : undefined
		);
		if (!result.ok) {
			const status = result.reason === 'invalid' ? 400 : result.reason === 'conflict' ? 409 : 404;
			const error =
				result.reason === 'invalid'
					? result.message
					: result.reason === 'conflict'
						? 'That reading changed elsewhere — reload and try again.'
						: 'Could not update that reading.';
			return fail(status, { action: 'update' as const, error });
		}
		return { action: 'update' as const, savedId: result.record.id };
	},

	delete: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await setHealthMeasurementArchived(
			sql,
			viewer,
			String(form.get('id') ?? ''),
			true
		);
		if (!result.ok) {
			return fail(404, { action: 'delete' as const, error: 'Could not delete that reading.' });
		}
		return { action: 'delete' as const };
	}
};
