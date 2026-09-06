export interface PageTheme {
	image?: string;
	icon?: string;
	alt: string;
	accent: string;
	accentSoft: string;
	mark?: string;
}

const THEMES: Record<string, PageTheme> = {
	tasks: {
		image: '/images/pages/tasks.png',
		alt: 'Soft pink illustrated banner for planning and taking action.',
		accent: '#c05b78',
		accentSoft: '#4f2e40'
	},
	projects: {
		image: '/images/pages/projects.png',
		alt: 'Sage green illustrated banner for projects and next steps.',
		accent: '#83a987',
		accentSoft: '#294635'
	},
	goals: {
		image: '/images/pages/goals.png',
		alt: 'Warm cream illustrated banner for goals and milestones.',
		accent: '#d4a36b',
		accentSoft: '#5a3a21'
	},
	habits: {
		image: '/images/pages/habits.png',
		alt: 'Golden illustrated banner for habits and routines.',
		accent: '#d6af3c',
		accentSoft: '#514727'
	},
	areas: {
		image: '/images/pages/areas.png',
		alt: 'Warm watercolor banner about taking a holistic view of life areas.',
		accent: '#8eb397',
		accentSoft: '#294936'
	},
	journal: {
		image: '/images/pages/journal.png',
		alt: 'Blue watercolor banner about the days as they unfold.',
		accent: '#82a8cf',
		accentSoft: '#23394f'
	},
	inbox: {
		image: '/images/pages/quick-drop.png',
		alt: 'Lavender and cream banner for quickly capturing ideas.',
		accent: '#ad8bc2',
		accentSoft: '#3e304c'
	},
	review: {
		image: '/images/pages/review.png',
		alt: 'Warm terracotta banner for noticing what is working and what needs attention.',
		accent: '#c57c68',
		accentSoft: '#4f302d'
	},
	yearlyReview: {
		image: '/images/pages/yearly-review.png',
		alt: 'Lavender banner for yearly review and planning.',
		accent: '#a88db4',
		accentSoft: '#3d3047'
	},
	perspectives: {
		icon: '/images/pages/perspectives.png',
		alt: 'A quiet lavender workspace for noticing, learning, and choosing a perspective.',
		accent: '#b49ac1',
		accentSoft: '#3e3048'
	},
	health: {
		icon: '/images/pages/health.png',
		alt: 'A calm green workspace for health and fitness.',
		accent: '#8eb99b',
		accentSoft: '#294936'
	},
	food: {
		image: '/images/pages/food.png',
		alt: 'Warm illustrated kitchen banner for food planning.',
		accent: '#d99471',
		accentSoft: '#50332d'
	},
	finance: {
		icon: '/images/pages/finance.png',
		alt: 'A grounded green workspace for keeping finances clear.',
		accent: '#91b58c',
		accentSoft: '#294432'
	},
	entertainment: {
		image: '/images/pages/entertainment.png',
		alt: 'Cozy illustrated movie-night banner for entertainment planning.',
		accent: '#d38b72',
		accentSoft: '#50312e'
	},
	reading: {
		icon: '/images/pages/reading.png',
		alt: 'A quiet lavender workspace for tracking books and reading.',
		accent: '#ae9bc2',
		accentSoft: '#3e3048'
	},
	knowledge: {
		image: '/images/pages/knowledge.png',
		alt: 'Blue watercolor banner for collecting and connecting knowledge.',
		accent: '#8eafd0',
		accentSoft: '#263b52'
	},
	library: {
		image: '/images/pages/library.png',
		alt: 'Lavender illustrated banner for a personal library.',
		accent: '#ad91bb',
		accentSoft: '#42324b'
	},
	topics: {
		image: '/images/pages/topics.png',
		alt: 'Watercolor banner for topics and resources.',
		accent: '#c9a071',
		accentSoft: '#513a29'
	},
	people: {
		image: '/images/pages/people.png',
		alt: 'Sage illustrated banner for the people and places that make up a life.',
		accent: '#8ca88e',
		accentSoft: '#2e4532'
	},
	wishlist: {
		image: '/images/pages/wishlist.png',
		alt: 'Pink watercolor banner for small ideas and future joy.',
		accent: '#cf819a',
		accentSoft: '#512d3c'
	},
	quickDrop: {
		image: '/images/pages/quick-drop.png',
		alt: 'Lavender and cream banner for quickly capturing ideas.',
		accent: '#ad8bc2',
		accentSoft: '#3e304c'
	},
	brainDump: {
		image: '/images/pages/brain-dump.png',
		alt: 'Blue watercolor banner for clearing the mind and collecting thoughts.',
		accent: '#80a9ce',
		accentSoft: '#23394f'
	}
};

export function pageThemeFor(pathname: string): PageTheme | null {
	if (pathname.startsWith('/inbox')) return THEMES.inbox!;
	if (pathname.startsWith('/brain-dump')) return THEMES.brainDump!;
	if (pathname.startsWith('/review')) return THEMES.review!;
	if (pathname.startsWith('/yearly-review')) return THEMES.yearlyReview!;
	if (pathname.startsWith('/perspectives')) return THEMES.perspectives!;
	if (pathname.startsWith('/tasks')) return THEMES.tasks!;
	if (pathname.startsWith('/projects')) return THEMES.projects!;
	if (pathname.startsWith('/goals')) return THEMES.goals!;
	if (pathname.startsWith('/habits')) return THEMES.habits!;
	if (pathname.startsWith('/areas')) return THEMES.areas!;
	if (pathname.startsWith('/journal')) return THEMES.journal!;
	if (pathname.startsWith('/health')) return THEMES.health!;
	if (pathname.startsWith('/food')) return THEMES.food!;
	if (pathname.startsWith('/finance')) return THEMES.finance!;
	if (pathname.startsWith('/entertainment')) return THEMES.entertainment!;
	if (pathname.startsWith('/reading')) return THEMES.reading!;
	if (pathname.startsWith('/knowledge')) return THEMES.knowledge!;
	if (pathname.startsWith('/library')) return THEMES.library!;
	if (pathname.startsWith('/topics')) return THEMES.topics!;
	if (pathname.startsWith('/people')) return THEMES.people!;
	if (pathname.startsWith('/wishlist')) return THEMES.wishlist!;
	return null;
}
