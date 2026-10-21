import { fail } from '@sveltejs/kit';
import { discoverCalendars, ICLOUD_URL } from '$lib/server/calendar-sync/caldav';
import { GoogleError } from '$lib/server/calendar-sync/google';
import { syncDeps, syncOnce } from '$lib/server/calendar-sync/scheduler';
import { seal } from '$lib/server/calendar-sync/secret-box';
import { sql } from '$lib/server/db';
import {
	addCalendarSource,
	createCaldavConnection,
	deleteCalendarConnection,
	ensureGoogleConnection,
	listCalendarConnections,
	setPushTarget,
	updateCalendarSource
} from '$lib/server/repositories/calendar-sync';
import { requireViewer } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

/**
 * Calendar connections (docs/calendar-sync.md): a person connects their own
 * calendars, here, and nobody else's. Google calendars are shared with the
 * server's service account and added by id; a CalDAV account (iCloud by
 * default) signs in with an app-specific password, which is sealed before it
 * is stored and never shown again.
 */

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const load: PageServerLoad = async ({ locals }) => {
	const viewer = await requireViewer(locals.user);
	const deps = await syncDeps();
	return {
		connections: await listCalendarConnections(sql, viewer),
		serviceAccountEmail: deps.google?.serviceAccountEmail ?? null,
		canStoreSecrets: deps.secretKey !== null,
		icloudUrl: ICLOUD_URL
	};
};

export const actions: Actions = {
	addCaldav: async ({ request, locals }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const account = String(form.get('account') ?? '').trim();
		const secretValue = String(form.get('secret') ?? '').trim();
		const serverUrl = String(form.get('serverUrl') ?? '').trim() || ICLOUD_URL;
		if (!account || !secretValue) {
			return fail(400, {
				section: 'caldav',
				error: 'Enter the account and its app-specific password.'
			});
		}
		if (!/^https?:\/\//.test(serverUrl)) {
			return fail(400, {
				section: 'caldav',
				error: 'The server address must start with https://.'
			});
		}
		const deps = await syncDeps();
		if (!deps.secretKey) {
			return fail(400, {
				section: 'caldav',
				error: 'The server has no LIFEOS_SECRET_KEY, so it cannot store a password safely yet.'
			});
		}
		let calendars;
		try {
			calendars = await discoverCalendars({ serverUrl, username: account, password: secretValue });
		} catch (err) {
			return fail(400, { section: 'caldav', error: `Couldn't sign in: ${message(err)}` });
		}
		const connectionId = await createCaldavConnection(sql, viewer, {
			account,
			serverUrl,
			secret: seal(secretValue, deps.secretKey)
		});
		for (const cal of calendars) {
			await addCalendarSource(sql, viewer, connectionId, {
				externalId: cal.url,
				name: cal.name,
				color: cal.color,
				timeZone: cal.timeZone
			});
		}
		return {
			section: 'caldav',
			ok: `Connected ${account}: ${calendars.length} calendar(s). They sync within a few minutes.`
		};
	},

	addGoogle: async ({ request, locals }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const calendarId = String(form.get('calendarId') ?? '').trim();
		const asTarget = form.get('pushTarget') === 'on';
		if (!calendarId) return fail(400, { section: 'google', error: 'Enter the calendar ID.' });
		const { google } = await syncDeps();
		if (!google) {
			return fail(400, { section: 'google', error: 'Google is not configured on the server yet.' });
		}
		let calendar;
		try {
			calendar = await google.getCalendar(calendarId);
		} catch (err) {
			const notShared = err instanceof GoogleError && (err.status === 404 || err.status === 403);
			return fail(400, {
				section: 'google',
				error: notShared
					? `LifeOS can't see that calendar. Share it with ${google.serviceAccountEmail} first.`
					: `Google said: ${message(err)}`
			});
		}
		const connectionId = await ensureGoogleConnection(sql, viewer, google.serviceAccountEmail);
		await addCalendarSource(sql, viewer, connectionId, {
			externalId: calendarId,
			name: calendar.summary,
			timeZone: calendar.timeZone
		});
		if (asTarget) {
			const [source] = await sql<{ id: string }[]>`
				select id from calendar_sources where connection_id = ${connectionId} and external_id = ${calendarId}
			`;
			if (source) await setPushTarget(sql, viewer, source.id);
		}
		return { section: 'google', ok: `Added ${calendar.summary}.` };
	},

	updateSource: async ({ request, locals }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const visibility = String(form.get('visibility') ?? 'private');
		const ok = await updateCalendarSource(sql, viewer, String(form.get('sourceId') ?? ''), {
			importEnabled: form.get('importEnabled') === 'on',
			visibility: visibility === 'household' ? 'household' : 'private'
		});
		return ok ? { ok: 'Saved.' } : fail(404, { error: 'That calendar is not yours to change.' });
	},

	setTarget: async ({ request, locals }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const sourceId = String(form.get('sourceId') ?? '') || null;
		const ok = await setPushTarget(sql, viewer, sourceId);
		if (!ok) return fail(400, { error: 'Only your own Google calendars can hold LifeOS’s items.' });
		return {
			ok: sourceId
				? 'LifeOS will add its items to that calendar.'
				: 'LifeOS will stop adding its items.'
		};
	},

	remove: async ({ request, locals }) => {
		const viewer = await requireViewer(locals.user);
		const form = await request.formData();
		const ok = await deleteCalendarConnection(sql, viewer, String(form.get('connectionId') ?? ''));
		return ok
			? { ok: 'Removed.' }
			: fail(404, { error: 'That connection is not yours to remove.' });
	},

	syncNow: async ({ locals }) => {
		await requireViewer(locals.user);
		const report = await syncOnce(sql);
		if (!report) return { ok: 'A sync is already running; give it a minute.' };
		const p = report.pushed;
		return {
			ok:
				`Synced ${report.sources} calendar(s)` +
				(report.failures ? `, ${report.failures} with errors (see below)` : '') +
				(p.created + p.updated + p.deleted
					? `; LifeOS items: ${p.created} added, ${p.updated} updated, ${p.deleted} removed`
					: '') +
				'.'
		};
	}
};
