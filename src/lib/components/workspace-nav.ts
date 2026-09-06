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
			{ label: 'Inbox', icon: 'inbox' },
			{ label: 'Brain dump', icon: 'audit' },
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
			{ label: 'Review', icon: 'check' }
		]
	},
	{
		id: 'life',
		label: 'LIFE',
		color: '#c29e99',
		items: [
			{ label: 'Areas', icon: 'areas', href: '/areas' },
			{ label: 'Health', icon: 'habits' },
			{ label: 'Food', icon: 'today' },
			{ label: 'Finance', icon: 'audit' },
			{ label: 'Reading', icon: 'journal' },
			{ label: 'Entertainment', icon: 'today' }
		]
	},
	{
		id: 'reflect',
		label: 'REFLECT',
		color: '#aaa4bd',
		items: [
			{ label: 'Journal', icon: 'journal', href: '/journal' },
			{ label: 'Goals', icon: 'goals', href: '/goals' },
			{ label: 'Review', icon: 'check' },
			{ label: 'Perspectives', icon: 'today' }
		]
	},
	{
		id: 'knowledge',
		label: 'KNOWLEDGE',
		color: '#92b4ba',
		items: [
			{ label: 'Hub', icon: 'areas' },
			{ label: 'Library', icon: 'journal' },
			{ label: 'Topics', icon: 'projects' },
			{ label: 'People', icon: 'people' },
			{ label: 'Wishlist', icon: 'goals' }
		]
	},
	{
		id: 'create',
		label: 'CREATE',
		color: '#b6b58d',
		items: [
			{ label: 'Store', icon: 'projects' },
			{ label: 'Content', icon: 'journal' }
		]
	},
	{
		id: 'back-end',
		label: 'BACK END',
		color: '#a7a5a1',
		items: [
			{ label: 'System', icon: 'areas' },
			{ label: 'Dashboard', icon: 'audit' },
			{ label: 'Archive', icon: 'projects' },
			{ label: 'Bin', icon: 'inbox' }
		]
	}
];
