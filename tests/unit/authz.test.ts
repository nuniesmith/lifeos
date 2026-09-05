import { describe, expect, it } from 'vitest';
import { canRead, canWrite, type OwnedRecord, type Viewer } from '$lib/server/auth/authz';

const HOUSE = '11111111-1111-1111-1111-111111111111';
const OTHER_HOUSE = '22222222-2222-2222-2222-222222222222';
const JORDAN = 'aaaaaaaa-0000-0000-0000-000000000001';
const PARTNER = 'aaaaaaaa-0000-0000-0000-000000000002';

const admin: Viewer = { userId: JORDAN, householdId: HOUSE, role: 'admin' };
const member: Viewer = { userId: PARTNER, householdId: HOUSE, role: 'member' };

const rec = (over: Partial<OwnedRecord> = {}): OwnedRecord => ({
	householdId: HOUSE,
	ownerUserId: JORDAN,
	visibility: 'household',
	...over
});

describe('household isolation', () => {
	it('refuses another household to a member', () => {
		expect(canRead(rec({ householdId: OTHER_HOUSE }), member)).toBe(false);
	});

	it('refuses another household to an admin as well', () => {
		// Household isolation is absolute; the admin role does not cross it.
		expect(canRead(rec({ householdId: OTHER_HOUSE }), admin)).toBe(false);
		expect(canRead(rec({ householdId: OTHER_HOUSE, visibility: 'household' }), admin)).toBe(false);
	});
});

describe('private visibility', () => {
	it('lets the owner read their own private record', () => {
		expect(canRead(rec({ ownerUserId: PARTNER, visibility: 'private' }), member)).toBe(true);
	});

	it('hides a private record from the other household member', () => {
		expect(canRead(rec({ ownerUserId: PARTNER, visibility: 'private' }), admin)).toBe(false);
	});

	it('does not let an admin read a member private record', () => {
		// The plan is explicit: administration covers accounts and system
		// operations, not reading someone else's journal or medical log.
		const journal = rec({ ownerUserId: PARTNER, visibility: 'private' });
		expect(canRead(journal, admin)).toBe(false);
		expect(canWrite(journal, admin)).toBe(false);
	});

	it('shares household-visible records with both members', () => {
		expect(canRead(rec({ ownerUserId: JORDAN, visibility: 'household' }), member)).toBe(true);
	});
});

describe('write access', () => {
	it('lets the owner write their own record', () => {
		expect(canWrite(rec({ ownerUserId: JORDAN }), admin)).toBe(true);
	});

	it('refuses a non-owner writing a shared record', () => {
		// Readable, but not editable: shared visibility is not shared ownership.
		const shared = rec({ ownerUserId: JORDAN, visibility: 'household' });
		expect(canRead(shared, member)).toBe(true);
		expect(canWrite(shared, member)).toBe(false);
	});

	it('lets either member edit an unowned household record', () => {
		const shopping = rec({ ownerUserId: null, visibility: 'household' });
		expect(canWrite(shopping, member)).toBe(true);
		expect(canWrite(shopping, admin)).toBe(true);
	});

	it('never permits writing across households', () => {
		expect(canWrite(rec({ householdId: OTHER_HOUSE, ownerUserId: null }), admin)).toBe(false);
	});
});
