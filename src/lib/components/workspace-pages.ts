import type { WorkspaceSection } from './WorkspacePage.svelte';

export interface WorkspacePageConfig {
	title: string;
	description: string;
	sections: readonly WorkspaceSection[];
	actions?: readonly { label: string; href: string }[];
}

const PAGES: Record<string, WorkspacePageConfig> = {
	inbox: {
		title: 'Quick Drop | Inbox',
		description: 'Get it out of your head now. Figure out where it belongs later.',
		actions: [{ label: 'Open tasks', href: '/tasks' }],
		sections: [
			{
				title: 'Capture first',
				body: 'A low-friction landing place for the ideas and obligations that arrive mid-day.',
				accent: '#ad8bc2',
				items: [
					{
						symbol: '＋',
						label: 'New task',
						body: 'Turn a thought into a next action.',
						href: '/tasks'
					},
					{
						symbol: '💭',
						label: 'Brain dump',
						body: 'Make space before deciding.',
						href: '/brain-dump'
					},
					{
						symbol: '✓',
						label: 'Open task inbox',
						body: 'See everything waiting for a home.',
						href: '/tasks?view=open'
					}
				]
			}
		]
	},
	'brain-dump': {
		title: 'Brain Dump',
		description: 'Get it out. Clear the space. You’ll figure it out later.',
		sections: [
			{
				title: 'Clear the space',
				body: 'Capture loose thoughts without asking them to be organized yet.',
				accent: '#80a9ce',
				items: [
					{
						symbol: '📥',
						label: 'Quick Drop',
						body: 'Capture a thought and keep moving.',
						href: '/inbox'
					},
					{
						symbol: '☑',
						label: 'Make it actionable',
						body: 'Give a clear next step to something that needs doing.',
						href: '/tasks'
					},
					{
						symbol: '📓',
						label: 'Let it be a journal entry',
						body: 'Keep the context when the thought is about the day.',
						href: '/journal'
					}
				]
			}
		]
	},
	review: {
		title: 'For Review',
		description: 'Notice what is working, what is not, and what needs attention.',
		sections: [
			{
				title: 'A small review loop',
				body: 'Use the live workspace views to decide what deserves your attention next.',
				accent: '#c57c68',
				items: [
					{
						symbol: '△',
						label: 'Overdue tasks',
						body: 'Clear, reschedule, or consciously drop them.',
						href: '/tasks?view=overdue'
					},
					{
						symbol: '▱',
						label: 'Projects in motion',
						body: 'Check the next step and the finish line.',
						href: '/projects?view=active'
					},
					{
						symbol: '◎',
						label: 'Goals needing care',
						body: 'Reconnect the work to what it is for.',
						href: '/goals?view=active'
					},
					{
						symbol: '◌',
						label: 'Areas to revisit',
						body: 'Look for quiet obligations before they become loud.',
						href: '/areas?view=review'
					}
				]
			}
		]
	},
	'yearly-review': {
		title: 'Reflect & Reset: Yearly Review & Planning',
		description: 'Look back, check in, dream, plan, and grow.',
		sections: [
			{
				title: 'Start here',
				body: 'This is a menu, not homework. Use the sections that are useful and skip the rest.',
				accent: '#a88db4',
				items: [
					{
						symbol: '←',
						label: 'Look back',
						body: 'What gave the year shape? What do you want to remember?',
						href: '/journal'
					},
					{
						symbol: '◌',
						label: 'Check in',
						body: 'Notice your energy, relationships, and current capacity.',
						href: '/areas'
					},
					{
						symbol: '✦',
						label: 'Dream and plan',
						body: 'Choose a few directions worth making room for.',
						href: '/goals'
					}
				]
			}
		]
	},
	perspectives: {
		title: 'Perspectives',
		description: 'A place to notice, question, and choose the lens you want to carry.',
		sections: [
			{
				title: 'Areas to explore',
				body: 'A few gentle prompts for seeing the same life from a different angle.',
				accent: '#b49ac1',
				items: [
					{
						symbol: '⌕',
						label: 'What do I notice?',
						body: 'Name what is present before trying to fix it.'
					},
					{
						symbol: '♡',
						label: 'What is working?',
						body: 'Keep the systems and relationships that are helping.'
					},
					{
						symbol: '↗',
						label: 'What wants attention?',
						body: 'Choose one small place to bring care.'
					},
					{
						symbol: '✧',
						label: 'What am I learning?',
						body: 'Let experience become useful knowledge.'
					}
				]
			}
		]
	},
	health: {
		title: 'Health & Fitness',
		description: 'Support the body and mind with small, visible systems.',
		sections: [
			{
				title: 'Keep the basics visible',
				body: 'A calm home for movement, care, appointments, and the routines that support them.',
				accent: '#8eb99b',
				items: [
					{
						symbol: '↻',
						label: 'Habits & routines',
						body: 'Log the small things that keep you steady.',
						href: '/habits'
					},
					{
						symbol: '♡',
						label: 'Health area',
						body: 'Keep longer-running care connected to an area.',
						href: '/areas'
					},
					{
						symbol: '📓',
						label: 'Daily check-in',
						body: 'Notice energy, mood, and what your body is saying.',
						href: '/journal'
					}
				]
			}
		]
	},
	food: {
		title: 'Food HQ',
		description: 'Make feeding yourself easier before the week gets busy.',
		sections: [
			{
				title: 'A little kitchen command centre',
				body: 'Keep the plan close to the recipes, groceries, and meals that make it real.',
				accent: '#d99471',
				items: [
					{
						symbol: '▦',
						label: 'Meal planner',
						body: 'Sketch the week around capacity, not perfection.'
					},
					{
						symbol: '⌕',
						label: 'Recipe library',
						body: 'Collect the meals you actually want to make.'
					},
					{ symbol: '✓', label: 'Shopping list', body: 'Turn the plan into a short, usable list.' }
				]
			}
		]
	},
	finance: {
		title: 'Financial Hub',
		description: 'Make the money side of life easier to see and maintain.',
		sections: [
			{
				title: 'Keep money clear',
				body: 'A steady place for recurring obligations, goals, and decisions that benefit from visibility.',
				accent: '#91b58c',
				items: [
					{
						symbol: '$',
						label: 'Financial area',
						body: 'Keep ongoing money work connected.',
						href: '/areas'
					},
					{
						symbol: '↻',
						label: 'Recurring obligations',
						body: 'Review bills and subscriptions before they surprise you.'
					},
					{
						symbol: '◎',
						label: 'Longer-term direction',
						body: 'Connect decisions back to the goals they support.',
						href: '/goals'
					}
				]
			}
		]
	},
	entertainment: {
		title: 'Entertainment',
		description: 'Keep a little room for play, culture, and things worth looking forward to.',
		sections: [
			{
				title: 'Press play, relax, enjoy',
				body: 'A gentle place to collect what sounds good without turning rest into another project.',
				accent: '#d38b72',
				items: [
					{
						symbol: '▶',
						label: 'Tonight’s shortlist',
						body: 'A few things that fit the energy you have.'
					},
					{
						symbol: '☆',
						label: 'Saved for later',
						body: 'Movies, shows, games, and events to come back to.'
					},
					{ symbol: '♡', label: 'Good company', body: 'Ideas for shared time and small outings.' }
				]
			}
		]
	},
	reading: {
		title: 'Reading Tracker',
		description: 'Keep the next good book close without making reading a race.',
		sections: [
			{
				title: 'Read with intention',
				body: 'A small shelf for what you are reading, what you want to read, and what stayed with you.',
				accent: '#ae9bc2',
				items: [
					{
						symbol: '▤',
						label: 'Currently reading',
						body: 'Keep the book you are returning to visible.',
						href: '/library'
					},
					{
						symbol: '＋',
						label: 'Next up',
						body: 'Save a few titles for the mood you are in.',
						href: '/wishlist'
					},
					{
						symbol: '✧',
						label: 'Notes to revisit',
						body: 'Keep the lines and ideas worth carrying forward.',
						href: '/knowledge'
					}
				]
			}
		]
	},
	knowledge: {
		title: 'Knowledge Hub',
		description: 'A home for the ideas, references, and questions that keep unfolding.',
		sections: [
			{
				title: 'Collect and connect',
				body: 'Knowledge is more useful when it has somewhere to land and a path back out.',
				accent: '#8eafd0',
				items: [
					{
						symbol: '▤',
						label: 'Library',
						body: 'Keep books and reading notes together.',
						href: '/library'
					},
					{
						symbol: '🏷',
						label: 'Topics & resources',
						body: 'Follow threads of curiosity over time.',
						href: '/topics'
					},
					{
						symbol: '♧',
						label: 'People & places',
						body: 'Remember the context around what you learn.',
						href: '/people'
					}
				]
			}
		]
	},
	library: {
		title: 'Library',
		description: 'Books, notes, and the quiet pleasure of having somewhere to browse.',
		sections: [
			{
				title: 'A shelf for the life you are building',
				body: 'Keep the next page, the useful reference, and the book you keep recommending close at hand.',
				accent: '#ad91bb',
				items: [
					{
						symbol: '▤',
						label: 'Reading tracker',
						body: 'See what is in progress and what is next.',
						href: '/reading'
					},
					{
						symbol: '⌕',
						label: 'Topics',
						body: 'Browse ideas by the questions they connect to.',
						href: '/topics'
					},
					{
						symbol: '✎',
						label: 'Notes',
						body: 'Keep the parts worth returning to.',
						href: '/knowledge'
					}
				]
			}
		]
	},
	topics: {
		title: 'Topics & Resources',
		description: 'Ideas, interests, and subjects I’m collecting and exploring.',
		sections: [
			{
				title: 'Follow the threads',
				body: 'Give curiosity a place to grow without needing to decide what it means yet.',
				accent: '#c9a071',
				items: [
					{
						symbol: '🏷',
						label: 'Topics',
						body: 'Name the questions and subjects that keep returning.'
					},
					{
						symbol: '⌕',
						label: 'Resources',
						body: 'Save articles, tools, and references with their context.'
					},
					{ symbol: '✦', label: 'Open loops', body: 'Keep the next useful question visible.' }
				]
			}
		]
	},
	people: {
		title: 'People & Places',
		description: 'The people, places, and connections that make up a life.',
		sections: [
			{
				title: 'Keep connection close',
				body: 'A simple home for important contacts, providers, places, and the details you do not want to search for twice.',
				accent: '#8ca88e',
				items: [
					{
						symbol: '♧',
						label: 'People',
						body: 'Family, friends, coworkers, and the people you want to remember.'
					},
					{
						symbol: '⌖',
						label: 'Places',
						body: 'The shops, services, and places that matter to your life.'
					},
					{
						symbol: '♡',
						label: 'Providers',
						body: 'Keep healthcare and other important service details together.'
					}
				]
			}
		]
	},
	wishlist: {
		title: 'Wishlist',
		description: 'Little ideas, future joy, and the things worth making room for.',
		sections: [
			{
				title: 'Good things take time',
				body: 'Keep possibilities somewhere gentle, so wanting something does not become another urgent task.',
				accent: '#cf819a',
				items: [
					{ symbol: '♡', label: 'Things', body: 'Objects that would bring usefulness or delight.' },
					{
						symbol: '✦',
						label: 'Experiences',
						body: 'Places to go, things to try, and time to make.'
					},
					{
						symbol: '⌕',
						label: 'Research later',
						body: 'Ideas that deserve a second look when capacity returns.'
					}
				]
			}
		]
	},
	store: {
		title: 'Store',
		description: 'A home for the work of making, listing, and growing the things you sell.',
		actions: [{ label: 'Open projects', href: '/projects' }],
		sections: [
			{
				title: 'Keep the shop moving',
				body: 'The Etsy Store Manager export gives this space a clear home for products, orders, and the work behind them.',
				accent: '#d89276',
				items: [
					{
						symbol: '▱',
						label: 'Listings & ideas',
						body: 'Keep products, variations, and the next listing visible.',
						href: '/projects'
					},
					{
						symbol: '✓',
						label: 'Orders & fulfillment',
						body: 'Give the small operational details somewhere to land.'
					},
					{
						symbol: '✎',
						label: 'Shop content',
						body: 'Connect product work to the words and images that help it sell.',
						href: '/content'
					}
				]
			}
		]
	},
	content: {
		title: 'Content',
		description:
			'A calm place for ideas, drafts, publishing, and the creative work that supports the rest of life.',
		actions: [{ label: 'Open projects', href: '/projects' }],
		sections: [
			{
				title: 'Make the work findable',
				body: 'The Content Creation export becomes a simple studio: collect the idea, shape the draft, and decide what happens next.',
				accent: '#caa071',
				items: [
					{
						symbol: '✦',
						label: 'Ideas & prompts',
						body: 'Capture the spark before it turns into another open loop.',
						href: '/inbox'
					},
					{
						symbol: '✎',
						label: 'Drafts in progress',
						body: 'Keep active pieces connected to a clear next step.',
						href: '/projects'
					},
					{
						symbol: '↗',
						label: 'Publishing plan',
						body: 'Make room for the cadence that feels sustainable.'
					}
				]
			}
		]
	},
	system: {
		title: 'System',
		description:
			'The structure underneath Life OS: accounts, data, maintenance, and the small details that keep it dependable.',
		sections: [
			{
				title: 'Keep the engine healthy',
				body: 'A quiet place to check the foundation without letting maintenance take over the workspace.',
				accent: '#a7a5a1',
				items: [
					{
						symbol: '⚙',
						label: 'Account & credentials',
						body: 'Manage sign-in details and security settings.',
						href: '/account/credentials'
					},
					{
						symbol: '⌁',
						label: 'Data & imports',
						body: 'Keep the source material and the working records in step.'
					},
					{
						symbol: '◌',
						label: 'System status',
						body: 'A future home for backups, health checks, and maintenance notes.'
					}
				]
			},
			{
				title: 'Core records',
				body: 'The records most of the workspace is built around.',
				accent: '#8fa8c2',
				items: [
					{ symbol: '☑', label: 'Tasks', body: 'Actions and commitments.', href: '/tasks' },
					{ symbol: '▱', label: 'Projects', body: 'Work with a finish line.', href: '/projects' },
					{ symbol: '🌿', label: 'Life areas', body: 'The standing parts of life.', href: '/areas' }
				]
			}
		]
	},
	dashboard: {
		title: 'Dashboard',
		description:
			'A map of the spaces that make up your Life OS, with a clear path back to each one.',
		sections: [
			{
				title: 'Start with today',
				body: 'The dashboard is the overview; the linked spaces hold the detail.',
				accent: '#8fa8c2',
				items: [
					{ symbol: '☀', label: 'Home', body: 'See today at a glance.', href: '/' },
					{ symbol: '☑', label: 'Tasks', body: 'Choose the next action.', href: '/tasks' },
					{ symbol: '📓', label: 'Journal', body: 'Keep the daily log moving.', href: '/journal' },
					{ symbol: '◎', label: 'Review', body: 'Notice what needs attention.', href: '/review' }
				]
			},
			{
				title: 'Master dashboards',
				body: 'The larger views for planning, reflection, life, and knowledge.',
				accent: '#a7a5a1',
				items: [
					{
						symbol: '🎯',
						label: 'Direction',
						body: 'Goals, habits, and perspectives.',
						href: '/goals'
					},
					{ symbol: '🌿', label: 'Life', body: 'Areas, health, food, and more.', href: '/areas' },
					{
						symbol: '📚',
						label: 'Knowledge',
						body: 'Ideas, books, and connections.',
						href: '/knowledge'
					},
					{ symbol: '✎', label: 'Create', body: 'Store and content work.', href: '/content' }
				]
			}
		]
	},
	archive: {
		title: 'Archive',
		description:
			'A quieter place for completed, paused, and inactive records that are still worth keeping.',
		sections: [
			{
				title: 'Put things away with intention',
				body: 'Archived does not mean forgotten. It means the active workspace can stay clear.',
				accent: '#c6a16c',
				items: [
					{
						symbol: '☑',
						label: 'Completed tasks',
						body: 'Review work that is finished.',
						href: '/tasks?view=done'
					},
					{
						symbol: '▱',
						label: 'Archived projects',
						body: 'Keep the history without the noise.',
						href: '/projects?view=archived'
					},
					{
						symbol: '◎',
						label: 'Archived goals',
						body: 'Remember directions that have changed.',
						href: '/goals?view=archived'
					},
					{
						symbol: '🌿',
						label: 'Archived areas',
						body: 'Retain the context for later.',
						href: '/areas?view=archived'
					}
				]
			}
		]
	},
	bin: {
		title: 'Bin',
		description: 'A holding place for records that no longer belong in active views.',
		sections: [
			{
				title: 'Clear without rushing',
				body: 'The Tasks Bin export gives this space a home while the permanent delete and restore workflows are built out.',
				accent: '#b58bad',
				items: [
					{
						symbol: '⌫',
						label: 'Dropped tasks',
						body: 'Keep a record of work you consciously chose not to carry forward.',
						href: '/tasks?view=done'
					},
					{
						symbol: '↶',
						label: 'Restore later',
						body: 'A future restore flow can bring an item back without losing its history.'
					},
					{
						symbol: '✦',
						label: 'Keep the workspace light',
						body: 'Use the bin as a pause between deciding and permanently removing.'
					}
				]
			}
		]
	}
};

export function workspacePageFor(slug: string): WorkspacePageConfig {
	return PAGES[slug] ?? PAGES.inbox!;
}
