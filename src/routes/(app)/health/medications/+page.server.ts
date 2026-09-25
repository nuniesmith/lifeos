import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import {
	MEDICATION_STATUSES,
	MEDICATION_TYPES,
	SCHEDULE_KINDS,
	archiveMedication,
	computeDueStatus,
	createMedication,
	householdToday,
	listMedications,
	logDose,
	recentDosesFor,
	setMedicationRunningLow,
	unarchiveMedication,
	undoDose,
	updateMedication,
	type DueStatus,
	type Medication,
	type MedicationDose,
	type WriteFailure
} from '$lib/server/repositories';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Medications & supplements.
 *
 * Grouped the way the source page groups its cards — Daily AM, Daily PM,
 * Scheduled, As needed — with "due today" and "next due" recomputed from the
 * dose history rather than read off a stored formula result; see
 * `computeDueStatus` in the repository for why.
 *
 * Linked from, but does not touch, `/health` — the landing page belongs to a
 * sibling change on this branch's neighbour.
 */

export interface MedicationView extends Medication {
	dueStatus: DueStatus;
	takenToday: boolean;
	recentDoses: MedicationDose[];
}

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const today = await householdToday(sql, viewer.householdId);

	const medications = await listMedications(sql, viewer, { limit: 300, order: 'name' });
	const doses = await recentDosesFor(
		sql,
		viewer,
		medications.map((m) => m.id),
		10
	);

	const withStatus: MedicationView[] = medications.map((medication) => {
		const recentDoses = doses.get(medication.id) ?? [];
		const dueStatus = computeDueStatus(
			medication,
			recentDoses.map((d) => d.onDate),
			today
		);
		return { ...medication, dueStatus, takenToday: dueStatus.lastTakenOn === today, recentDoses };
	});

	return {
		today,
		medications: withStatus,
		scheduleKinds: SCHEDULE_KINDS,
		types: MEDICATION_TYPES,
		statuses: MEDICATION_STATUSES
	};
};

/** A `WriteResult`'s failure reason, mapped onto the HTTP status that best
 *  names it — every reason the repository layer can return, not just the
 *  two or three a given action happens to hit in practice. */
const statusFor = (reason: WriteFailure): 400 | 403 | 404 | 409 =>
	reason === 'invalid' ? 400 : reason === 'not_found' ? 404 : reason === 'forbidden' ? 403 : 409;

const str = (form: FormData, key: string): string => String(form.get(key) ?? '');
const optStr = (form: FormData, key: string): string | undefined => {
	const v = form.get(key);
	return v === null ? undefined : String(v);
};

/** Builds a `MedicationInput` from a form, leaving a field out entirely when
 *  its input was not part of the submission — `updateMedication`'s `patched`
 *  helper treats "absent" and "explicitly cleared" differently, and a partial
 *  edit form must not overwrite fields it never showed. */
function medicationInput(form: FormData) {
	const input: Record<string, unknown> = {};
	for (const key of [
		'name',
		'type',
		'dose',
		'unit',
		'brand',
		'scheduleKind',
		'startDate',
		'endDate',
		'status',
		'notes'
	]) {
		if (form.has(key)) input[key] = str(form, key);
	}
	if (form.has('scheduledWeekday')) {
		const v = str(form, 'scheduledWeekday');
		input.scheduledWeekday = v === '' ? null : v;
	}
	if (form.has('intervalDays')) {
		const v = str(form, 'intervalDays');
		input.intervalDays = v === '' ? null : v;
	}
	if (form.has('runningLow')) input.runningLow = form.get('runningLow') === 'on';
	return input;
}

export const actions: Actions = {
	addMedication: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();

		const result = await createMedication(sql, viewer, medicationInput(form));
		if (!result.ok)
			return fail(statusFor(result.reason), { error: result.message ?? 'Could not add that.' });
		return { saved: result.record.id };
	},

	updateMedication: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = str(form, 'id');
		const updatedAt = optStr(form, 'updatedAt');

		const result = await updateMedication(sql, viewer, id, medicationInput(form), updatedAt);
		if (!result.ok)
			return fail(statusFor(result.reason), { error: result.message ?? 'Could not save that.' });
		return { saved: result.record.id };
	},

	archiveMedication: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const id = str(form, 'id');
		const archived = str(form, 'archived') === 'true';

		const result = archived
			? await archiveMedication(sql, viewer, id)
			: await unarchiveMedication(sql, viewer, id);
		if (!result.ok) return fail(statusFor(result.reason), { error: 'Could not update that.' });
		return { archived };
	},

	toggleRunningLow: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const result = await setMedicationRunningLow(
			sql,
			viewer,
			str(form, 'id'),
			str(form, 'runningLow') === 'true'
		);
		if (!result.ok) return fail(statusFor(result.reason), { error: 'Could not update that.' });
		return { updated: result.record.id };
	},

	/** The one-tap "taken today" toggle. `taken=true` logs today's dose;
	 *  `taken=false` undoes it — the row itself decides which by comparing its
	 *  current state, same as `archiveTerm` / `togglePrep` elsewhere. */
	toggleDose: async ({ locals, request }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const medicationId = str(form, 'medicationId');
		const onDate = optStr(form, 'onDate') ?? (await householdToday(sql, viewer.householdId));
		const taken = str(form, 'taken') === 'true';

		const result = taken
			? await logDose(sql, viewer, medicationId, onDate)
			: await undoDose(sql, viewer, medicationId, onDate);
		if (!result.ok)
			return fail(statusFor(result.reason), { error: 'Could not update today’s log.' });
		return { logged: taken };
	}
};
