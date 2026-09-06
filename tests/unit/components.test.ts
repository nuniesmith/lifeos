import { describe, expect, it } from 'vitest';
import { createRawSnippet, type Snippet } from 'svelte';
import { render } from 'svelte/server';
import Badge from '$lib/components/Badge.svelte';
import BottomNav from '$lib/components/BottomNav.svelte';
import Button from '$lib/components/Button.svelte';
import Checkbox from '$lib/components/Checkbox.svelte';
import EmptyState from '$lib/components/EmptyState.svelte';
import ErrorState from '$lib/components/ErrorState.svelte';
import Input from '$lib/components/Input.svelte';
import ListRow from '$lib/components/ListRow.svelte';
import LoadingState from '$lib/components/LoadingState.svelte';
import PageHeader from '$lib/components/PageHeader.svelte';
import QuickAdd from '$lib/components/QuickAdd.svelte';
import Select from '$lib/components/Select.svelte';
import SideNav from '$lib/components/SideNav.svelte';
import Textarea from '$lib/components/Textarea.svelte';
import { WORKSPACE_GROUPS } from '$lib/components/workspace-nav';
import {
	ADMIN_DESTINATIONS,
	APP_DESTINATIONS,
	BAR_DESTINATIONS,
	OVERFLOW_DESTINATIONS,
	adminDestinationsFor,
	isCurrent
} from '$lib/components/nav';

/**
 * Component tests via server-side render.
 *
 * The vitest `unit` project runs in a node environment, so these assert the
 * HTML the server actually sends rather than driving a DOM. That is the right
 * boundary for this ticket: what is being tested is markup and accessibility
 * wiring — label association, aria-current, whether a link exists at all —
 * and every one of those is decided before hydration. Behaviour that needs a
 * real browser (the quick-add sheet, tapping a bottom-bar destination) is
 * covered by tests/e2e/shell.spec.ts instead.
 */

const member = { displayName: 'Sam', role: 'member' };
const admin = { displayName: 'Jordan', role: 'admin' };

/** Extracts the value of an attribute from a rendered tag. */
function attr(html: string, tag: string, name: string): string | undefined {
	const pattern = new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, 'i');
	return pattern.exec(html)?.[1];
}

describe('nav destinations', () => {
	it('lists every section the shell promises', () => {
		expect(APP_DESTINATIONS.map((d) => d.label)).toEqual([
			'Today',
			'Tasks',
			'Habits',
			'Journal',
			'Projects',
			'Areas',
			'Goals'
		]);
	});

	it('splits the bottom bar at four, with the rest behind More', () => {
		// A fifth bar slot plus More makes each target narrower than a thumb.
		expect(BAR_DESTINATIONS).toHaveLength(4);
		expect(BAR_DESTINATIONS.length + OVERFLOW_DESTINATIONS.length).toBe(APP_DESTINATIONS.length);
		// No destination may be in both, or one tap would light up two places.
		const overlap = BAR_DESTINATIONS.filter((b) =>
			OVERFLOW_DESTINATIONS.some((o) => o.href === b.href)
		);
		expect(overlap).toEqual([]);
	});

	it('offers admin destinations only to an admin', () => {
		expect(adminDestinationsFor('admin')).toEqual(ADMIN_DESTINATIONS);
		expect(adminDestinationsFor('member')).toEqual([]);
		expect(adminDestinationsFor(undefined)).toEqual([]);
		// An unrecognised role is not an admin. Failing closed matters even
		// here, where the server is the real gate.
		expect(adminDestinationsFor('Admin')).toEqual([]);
		expect(adminDestinationsFor('superuser')).toEqual([]);
	});
});

describe('isCurrent', () => {
	it('matches Today only on the root path', () => {
		expect(isCurrent('/', '/')).toBe(true);
		expect(isCurrent('/tasks', '/')).toBe(false);
	});

	it('lets a section own its subtree', () => {
		expect(isCurrent('/tasks', '/tasks')).toBe(true);
		expect(isCurrent('/tasks/8f2', '/tasks')).toBe(true);
		expect(isCurrent('/admin/people', '/admin/people')).toBe(true);
	});

	it('stops at a path segment boundary', () => {
		// A sibling route that merely starts with the same letters is not the
		// same section.
		expect(isCurrent('/tasks-archive', '/tasks')).toBe(false);
		expect(isCurrent('/tasksarchive', '/tasks')).toBe(false);
	});

	it('ignores a trailing slash', () => {
		expect(isCurrent('/tasks/', '/tasks')).toBe(true);
		expect(isCurrent('/', '/')).toBe(true);
	});
});

describe('SideNav', () => {
	it('links implemented sections and marks the rest as upcoming', () => {
		const { body } = render(SideNav, {
			props: { user: member, pathname: '/', onQuickAdd: () => {} }
		});
		const sections = WORKSPACE_GROUPS.flatMap((group) => group.items);
		for (const item of sections.filter((item) => item.href)) {
			expect(body).toContain(`href="${item.href}"`);
		}
		for (const item of sections.filter((item) => !item.href)) {
			expect(body).toContain(item.label);
		}
		expect(body).toContain('Upcoming');
	});

	it('renders every destination once', () => {
		const { body } = render(SideNav, {
			props: { user: member, pathname: '/', onQuickAdd: () => {} }
		});
		for (const d of APP_DESTINATIONS) {
			expect(body).toMatch(new RegExp(`>\\s*${d.label}`));
		}
	});

	it('hides the admin group from a member', () => {
		const { body } = render(SideNav, {
			props: { user: member, pathname: '/', onQuickAdd: () => {} }
		});
		expect(body).not.toContain('/admin/people');
		expect(body).not.toContain('/admin/audit');
	});

	it('shows the admin group to an admin', () => {
		const { body } = render(SideNav, {
			props: { user: admin, pathname: '/', onQuickAdd: () => {} }
		});
		expect(body).toContain('/admin/people');
		expect(body).toContain('/admin/audit');
	});

	it('marks the open section with aria-current, and only that one', () => {
		const { body } = render(SideNav, {
			props: { user: member, pathname: '/tasks/8f2', onQuickAdd: () => {} }
		});
		expect(body.match(/aria-current="page"/g)).toHaveLength(1);
		// The marked link is the Tasks one.
		const tasksLink = /<a[^>]*href="\/tasks"[^>]*>/.exec(body)?.[0] ?? '';
		expect(tasksLink).toContain('aria-current="page"');
	});

	it('names the signed-in person and offers a sign-out', () => {
		const { body } = render(SideNav, {
			props: { user: admin, pathname: '/', onQuickAdd: () => {} }
		});
		expect(body).toContain('Jordan');
		expect(body).toContain('action="/logout"');
	});
});

describe('BottomNav', () => {
	it('puts four destinations on the bar and the rest in the sheet', () => {
		const { body } = render(BottomNav, { props: { user: member, pathname: '/' } });
		for (const d of APP_DESTINATIONS) {
			expect(body).toMatch(new RegExp(`>\\s*${d.label}`));
		}
		expect(body).toMatch(/>\s*More/);
	});

	it('hides admin links from a member', () => {
		const { body } = render(BottomNav, { props: { user: member, pathname: '/' } });
		expect(body).not.toContain('/admin/people');
		expect(body).not.toContain('/admin/audit');
	});

	it('shows admin links to an admin', () => {
		const { body } = render(BottomNav, { props: { user: admin, pathname: '/' } });
		expect(body).toContain('/admin/people');
		expect(body).toContain('/admin/audit');
	});

	it('gives the navigation landmarks distinct names', () => {
		// Both navs are in the DOM at once and only CSS hides one, so without
		// distinct labels a screen reader lists two identical "navigation"
		// landmarks.
		const bar = render(BottomNav, { props: { user: member, pathname: '/' } }).body;
		const side = render(SideNav, {
			props: { user: member, pathname: '/', onQuickAdd: () => {} }
		}).body;
		expect(attr(bar, 'nav', 'aria-label')).toBe('Main');
		expect(attr(side, 'nav', 'aria-label')).toBe('Sections');
	});
});

describe('Button', () => {
	it('is a button by default, and type="button" so it cannot submit by accident', () => {
		const { body } = render(Button, { props: { children: text('Save') } });
		expect(body).toContain('<button');
		expect(attr(body, 'button', 'type')).toBe('button');
	});

	it('is an anchor when given an href, with no disabled semantics', () => {
		const { body } = render(Button, { props: { href: '/tasks', children: text('All tasks') } });
		expect(body).toContain('<a');
		expect(attr(body, 'a', 'href')).toBe('/tasks');
	});

	it('marks a loading button busy and blocks a second submit', () => {
		const { body } = render(Button, { props: { loading: true, children: text('Save') } });
		expect(attr(body, 'button', 'aria-busy')).toBe('true');
		expect(body).toContain('disabled');
	});

	it('keeps an accessible name when the label is hidden', () => {
		const { body } = render(Button, {
			props: { iconOnly: true, icon: 'plus', children: text('Quick add') }
		});
		expect(body).toContain('sr-only');
		expect(body).toContain('Quick add');
	});
});

describe('form fields', () => {
	it('associates an input with its label and its hint', () => {
		const { body } = render(Input, {
			props: { label: 'Username', hint: 'Lower case, no spaces.' }
		});
		const labelFor = attr(body, 'label', 'for');
		const inputId = attr(body, 'input', 'id');
		expect(labelFor).toBeTruthy();
		expect(inputId).toBe(labelFor);
		expect(attr(body, 'input', 'aria-describedby')).toBe(`${inputId}-hint`);
	});

	it('marks an errored input invalid and points at the message', () => {
		const { body } = render(Input, {
			props: { label: 'Username', error: 'That username is taken.' }
		});
		const inputId = attr(body, 'input', 'id');
		expect(attr(body, 'input', 'aria-invalid')).toBe('true');
		expect(attr(body, 'input', 'aria-describedby')).toBe(`${inputId}-error`);
		expect(body).toContain('That username is taken.');
	});

	it('describes an input by both hint and error when both are present', () => {
		const { body } = render(Input, {
			props: { label: 'Username', hint: 'Lower case.', error: 'Taken.' }
		});
		const inputId = attr(body, 'input', 'id');
		expect(attr(body, 'input', 'aria-describedby')).toBe(`${inputId}-hint ${inputId}-error`);
	});

	it('honours a caller-supplied id so an external label can point at it', () => {
		const { body } = render(Input, { props: { label: 'Username', id: 'username' } });
		expect(attr(body, 'input', 'id')).toBe('username');
		expect(attr(body, 'label', 'for')).toBe('username');
	});

	it('associates a select and a textarea the same way', () => {
		const select = render(Select, {
			props: { label: 'Role', options: [{ value: 'member', label: 'Member' }] }
		}).body;
		expect(attr(select, 'select', 'id')).toBe(attr(select, 'label', 'for'));
		expect(select).toContain('Member');

		const textarea = render(Textarea, { props: { label: 'Notes' } }).body;
		expect(attr(textarea, 'textarea', 'id')).toBe(attr(textarea, 'label', 'for'));
	});

	it('keeps a hidden label in the accessibility tree', () => {
		const { body } = render(Input, { props: { label: 'Search', labelHidden: true } });
		expect(body).toContain('Search');
		expect(body).toContain('sr-only');
		expect(attr(body, 'label', 'for')).toBe(attr(body, 'input', 'id'));
	});

	it('gives every field in one document its own id', () => {
		// QuickAdd holds three fields and a dialog heading in a single render,
		// which is the case that matters: duplicated ids there would silently
		// point two labels at one control.
		const { body } = render(QuickAdd, { props: {} });
		const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThanOrEqual(4);
		expect(new Set(ids).size).toBe(ids.length);

		// And every label points at a control that exists.
		const fors = [...body.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
		expect(fors).toHaveLength(3);
		for (const target of fors) expect(ids).toContain(target);
	});
});

describe('Checkbox', () => {
	it('wraps a native checkbox in its own label, so no id is needed', () => {
		const { body } = render(Checkbox, { props: { label: 'Complete: book the vet' } });
		expect(body).toContain('type="checkbox"');
		expect(body).toContain('Complete: book the vet');
		expect(body).toContain('<label');
	});

	it('keeps the name available when it is visually hidden', () => {
		const { body } = render(Checkbox, {
			props: { label: 'Complete: book the vet', hideLabel: true }
		});
		expect(body).toContain('sr-only');
		expect(body).toContain('Complete: book the vet');
	});
});

describe('list and page furniture', () => {
	it('renders a row title as a link when a href is given', () => {
		const { body } = render(ListRow, { props: { title: 'Pay the hydro bill', href: '/tasks/t2' } });
		expect(attr(body, 'a', 'href')).toBe('/tasks/t2');
		expect(body).toContain('Pay the hydro bill');
	});

	it('renders a row without a link when there is nowhere to go', () => {
		const { body } = render(ListRow, { props: { title: 'Morning walk' } });
		expect(body).not.toContain('<a ');
		expect(body).toContain('Morning walk');
	});

	it('renders the page title as the one h1', () => {
		const { body } = render(PageHeader, { props: { title: 'Today', description: 'Friday' } });
		expect(body.match(/<h1/g)).toHaveLength(1);
		expect(body).toContain('Today');
		expect(body).toContain('Friday');
	});

	it('renders a badge with its tone as a class, not as inline colour', () => {
		const { body } = render(Badge, { props: { tone: 'crit', children: text('overdue') } });
		expect(body).toContain('overdue');
		expect(body).toMatch(/class="[^"]*\bcrit\b/);
		expect(body).not.toContain('style=');
	});
});

describe('state components', () => {
	it('announces loading politely rather than as an alert', () => {
		const { body } = render(LoadingState, { props: { label: 'Loading tasks…', lines: 4 } });
		expect(attr(body, 'div', 'role')).toBe('status');
		expect(attr(body, 'div', 'aria-live')).toBe('polite');
		expect(body).toContain('Loading tasks…');
		expect(body.match(/class="bar\b/g)).toHaveLength(4);
	});

	it('announces an error assertively and can show a reference', () => {
		const { body } = render(ErrorState, {
			props: { message: 'The list could not be loaded.', requestId: 'abc-123' }
		});
		expect(attr(body, 'div', 'role')).toBe('alert');
		expect(body).toContain('The list could not be loaded.');
		expect(body).toContain('abc-123');
	});

	it('states what is empty without pretending it is a failure', () => {
		const { body } = render(EmptyState, {
			props: { title: 'Nothing is overdue', description: 'Anything you miss shows up here.' }
		});
		expect(body).toContain('Nothing is overdue');
		expect(body).not.toContain('role="alert"');
	});
});

/**
 * A snippet of literal text, for components that take their content as one.
 *
 * `createRawSnippet` is the supported way to build a snippet outside a
 * `.svelte` file; hand-rolling the renderer callback couples the test to
 * Svelte's internal server payload shape, which has changed between minor
 * versions.
 */
function text(value: string): Snippet {
	return createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));
}
