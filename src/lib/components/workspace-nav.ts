import type { IconName } from './icons';

export interface WorkspaceItem {
	label: string;
	icon: IconName;
	/** Omitted until a corresponding page exists. */
	href?: string;
}

export interface WorkspaceGroup {
	id: string;
	label: string;
	color: string;
	items: readonly WorkspaceItem[];
}

/** Shared by the home directory and the expandable workspace navigation. */
export const WORKSPACE_GROUPS: readonly WorkspaceGroup[] = [
	{
		id: 'do',
		label: 'DO',
		color: '#bcaa8a',
		items: [
			{ label: 'Inbox', icon: 'inbox', href: '/inbox' },
			{ label: 'Brain dump', icon: 'audit', href: '/brain-dump' },
			{ label: 'Tasks', icon: 'tasks', href: '/tasks' },
			{ label: 'Habits', icon: 'habits', href: '/habits' }
		]
	},
	{
		id: 'plan',
		label: 'PLAN',
		color: '#a6b49a',
		items: [
			{ label: 'Calendar', icon: 'today' },
			{ label: 'Projects', icon: 'projects', href: '/projects' },
			{ label: 'Review', icon: 'check', href: '/review' }
		]
	},
	{
		id: 'life',
		label: 'LIFE',
		color: '#c29e99',
		items: [
			{ label: 'Areas', icon: 'areas', href: '/areas' },
			{ label: 'Health', icon: 'habits', href: '/health' },
			{ label: 'Food', icon: 'today', href: '/food' },
			{ label: 'Finance', icon: 'audit', href: '/finance' },
			{ label: 'Reading', icon: 'journal', href: '/reading' },
			{ label: 'Entertainment', icon: 'today', href: '/entertainment' }
		]
	},
	{
		id: 'reflect',
		label: 'REFLECT',
		color: '#aaa4bd',
		items: [
			{ label: 'Journal', icon: 'journal', href: '/journal' },
			{ label: 'Goals', icon: 'goals', href: '/goals' },
			{ label: 'Yearly review', icon: 'check', href: '/yearly-review' },
			{ label: 'Perspectives', icon: 'today', href: '/perspectives' }
		]
	},
	{
		id: 'knowledge',
		label: 'KNOWLEDGE',
		color: '#92b4ba',
		items: [
			{ label: 'Hub', icon: 'areas', href: '/knowledge' },
			{ label: 'Library', icon: 'journal', href: '/library' },
			{ label: 'Topics', icon: 'projects', href: '/topics' },
			{ label: 'People', icon: 'people', href: '/people' },
			{ label: 'Wishlist', icon: 'goals', href: '/wishlist' }
		]
	},
	{
		id: 'create',
		label: 'CREATE',
		color: '#b6b58d',
		items: [
			{ label: 'Store', icon: 'projects', href: '/store' },
			{ label: 'Content', icon: 'journal', href: '/content' }
		]
	},
	{
		id: 'back-end',
		label: 'BACK END',
		color: '#a7a5a1',
		items: [
			{ label: 'System', icon: 'areas', href: '/system' },
			{ label: 'Dashboard', icon: 'audit', href: '/dashboard' },
			{ label: 'Archive', icon: 'projects', href: '/archive' },
			{ label: 'Bin', icon: 'inbox', href: '/bin' }
		]
	}
];
