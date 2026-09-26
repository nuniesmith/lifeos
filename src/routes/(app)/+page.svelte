<script lang="ts">
	import { enhance } from '$app/forms';
	import { base, resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import HomeCalendar from '$lib/components/home/HomeCalendar.svelte';
	import HomeClock from '$lib/components/home/HomeClock.svelte';
	import { appPath } from '$lib/components/nav';
	import { WORKSPACE_GROUPS } from '$lib/components/workspace-nav';
	import type { IconName } from '$lib/components/icons';
	import DueMedicationRow from './health/DueMedicationRow.svelte';
	import { summaryOf } from './health/measurements/format';

	let { data, form } = $props();
	const isDone = (status: string) => status === 'done' || status === 'dropped';
	const openToday = $derived(data.dueToday.filter((task) => !isDone(task.status)).length);
	const habitsDone = $derived(data.habits.filter((habit) => habit.doneToday).length);

	// ─── today's health panel ────────────────────────────────────────────
	const dueMedications = $derived([
		...data.health.medications.am,
		...data.health.medications.pm,
		...data.health.medications.other
	]);
	// Compact means it can also be ABSENT: a fresh household with nothing due,
	// no reading ever taken and no visit on the calendar gets no panel at all,
	// rather than three empty-state prompts stacked under Habits.
	const hasHealthSignal = $derived(
		dueMedications.length > 0 ||
			data.health.visits.next !== null ||
			data.health.measurements.latestOverall !== null
	);
	const visitWhen = (at: Date): string =>
		`${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${at.toLocaleTimeString(
			undefined,
			{ hour: 'numeric', minute: '2-digit' }
		)}`;
	const quickCaptures: {
		label: string;
		icon: IconName;
		kind?: 'task' | 'note' | 'journal';
		href?: string;
	}[] = [
		{ label: 'New note', icon: 'journal', kind: 'note' },
		{ label: 'New reference', icon: 'inbox' },
		{ label: 'New journal entry', icon: 'journal', kind: 'journal' },
		{ label: 'New project', icon: 'projects', href: '/projects' },
		{ label: 'Perform review', icon: 'tasks' },
		{ label: 'New habit', icon: 'habits', href: '/habits' },
		{ label: 'New tag or topic', icon: 'areas', href: '/topics' },
		{ label: 'New task', icon: 'check', kind: 'task' },
		{ label: 'New wishlist item', icon: 'goals' },
		{ label: 'New contact', icon: 'people' }
	];

	const jumpGroups = [
		{
			label: 'Action',
			symbol: '⚡',
			links: [
				{ label: 'Quick drop | Inbox', symbol: '📥', href: '/inbox' },
				{ label: 'Brain dump', symbol: '💭', href: '/brain-dump' },
				{ label: 'To do / Action', symbol: '☑️', href: '/tasks' },
				{ label: 'My projects', symbol: '🗂️', href: '/projects' },
				{ label: 'For review', symbol: '📋', href: '/review' }
			]
		},
		{
			label: 'Direction',
			symbol: '🧭',
			links: [
				{ label: 'Goals & milestones', symbol: '🎯', href: '/goals' },
				{ label: 'Yearly review & planning', symbol: '⏱️', href: '/yearly-review' },
				{ label: 'Habits & routines', symbol: '🔁', href: '/habits' },
				{ label: 'Perspectives', symbol: '🔭', href: '/perspectives' },
				{ label: 'Life areas', symbol: '🌈', href: '/areas' }
			]
		},
		{
			label: 'Life',
			symbol: '🌿',
			links: [
				{ label: 'Journal', symbol: '📓', href: '/journal' },
				{ label: 'Health & fitness', symbol: '❤️', href: '/health' },
				{ label: 'Food HQ', symbol: '🍒', href: '/food' },
				{ label: 'Financial hub', symbol: '💸', href: '/finance' },
				{ label: 'Entertainment', symbol: '📺', href: '/entertainment' },
				{ label: 'Reading tracker', symbol: '📖', href: '/reading' }
			]
		},
		{
			label: 'Knowledge',
			symbol: '📚',
			links: [
				{ label: 'Knowledge hub', symbol: '✨', href: '/knowledge' },
				{ label: 'Library', symbol: '📚', href: '/library' },
				{ label: 'Topics & resources', symbol: '🏷️', href: '/topics' },
				{ label: 'People & places', symbol: '👥', href: '/people' },
				{ label: 'Wishlist', symbol: '🛍️', href: '/wishlist' }
			]
		}
	];

	function capture(kind: 'task' | 'note' | 'journal') {
		window.dispatchEvent(new CustomEvent('lifeos:quick-add', { detail: { kind } }));
	}

	function dateLabel(day: string) {
		return new Date(`${day}T12:00:00`).toLocaleDateString('en-CA', {
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>Life OS · Home</title>
	<meta name="description" content="Your days, plans, and everything that makes a life." />
</svelte:head>

<div class="home">
	<div class="cover">
		<img
			src={`${base}/images/home/life-os-cover.png`}
			alt="Life OS. Make a life worth remembering. A golden mountain lake beside books, a candle, and an open journal."
			width="1528"
			height="466"
			fetchpriority="high"
		/>
	</div>

	<div class="home-content">
		<header class="home-heading">
			<img
				class="page-icon"
				src={`${base}/images/home/home-icon.png`}
				alt=""
				width="76"
				height="76"
			/>
			<div class="title-row">
				<h1>Life OS</h1>
				<span class="welcome">A little space for your whole life.</span>
			</div>
		</header>

		<img
			class="memento"
			src={`${base}/images/home/memento-banner.png`}
			alt="Memento mori. Memento vivere. Remember you will die; not as a warning, but as a reason to live."
			width="1710"
			height="340"
		/>

		{#if form?.error}<p class="notice" role="alert">{form.error}</p>{/if}

		<div class="daily-grid">
			<aside class="overview" aria-label="Your overview">
				<HomeClock today={data.today} timezone={data.timezone} />
				<span class="view-label"><Icon name="areas" size={14} /> Overview</span>
				<div class="command-center">
					<div class="command-title">
						<img src={`${base}/images/home/home-icon.png`} alt="" width="20" height="20" /> My Life OS
					</div>
					<h3>Command center</h3>
					<a class="status-line overdue" href={resolve(appPath('/tasks?view=overdue'))}
						>△ {data.overdue.length} overdue task{data.overdue.length === 1 ? '' : 's'}</a
					>
					<a class="status-line amber" href={resolve(appPath('/inbox'))}
						>◇ {data.waitingCount} waiting in the inbox</a
					>
					<a class="status-line amber" href={resolve(appPath('/tasks'))}
						>◇ {data.inboxCount} tasks without a project</a
					>
					<a class="status-line blue" href={resolve('/journal')}
						>↻ Today's log {data.dailyLog ? 'started' : 'not started'}</a
					>
					<h3>Today, at a glance</h3>
					<a class="status-line green" href={resolve(appPath('/tasks?view=today'))}
						>✓ {openToday} task{openToday === 1 ? '' : 's'} left today</a
					>
					<a class="status-line mauve" href={resolve('/habits')}
						>✦ {habitsDone} / {data.habits.length} habits logged</a
					>
					<h3>In motion</h3>
					<a class="status-line blue" href={resolve('/projects')}
						>▱ Projects <span class="arrow">↗</span></a
					>
					<a class="status-line mauve" href={resolve('/goals')}
						>◎ Goals & milestones <span class="arrow">↗</span></a
					>
				</div>

				<details class="menu-panel">
					<summary><span aria-hidden="true">📸</span> Quick Capture</summary>
					<div class="capture-links">
						{#each quickCaptures as item (item.label)}
							{#if item.kind}
								<button type="button" onclick={() => capture(item.kind!)}
									><Icon name={item.icon} size={16} />{item.label}</button
								>
							{:else if item.href}
								<a href={resolve(appPath(item.href))}
									><Icon name={item.icon} size={16} />{item.label}</a
								>
							{:else}
								<span class="unavailable"
									><Icon name={item.icon} size={16} />{item.label}<small>Soon</small></span
								>
							{/if}
						{/each}
					</div>
				</details>

				<details class="menu-panel workspace-menu">
					<summary
						><img src={`${base}/images/home/home-icon.png`} alt="" width="21" height="21" /> Life OS</summary
					>
					<div class="workspace-groups">
						{#each WORKSPACE_GROUPS as group (group.id)}
							<h3 style:color={group.color}>{group.label}</h3>
							{#each group.items as item (item.label)}
								{#if item.href}<a href={resolve(appPath(item.href))}
										><Icon name={item.icon} size={15} />{item.label}</a
									>
								{:else}<span class="unavailable"
										><Icon name={item.icon} size={15} />{item.label}<small>Soon</small></span
									>{/if}
							{/each}
						{/each}
					</div>
				</details>
			</aside>

			<section class="today" id="today" aria-labelledby="today-heading">
				<h2 id="today-heading">☀️ Today</h2>
				<p class="section-note gold">The shape of today at a glance.</p>
				<div class="database-header">
					<h3><Icon name="journal" size={20} /> Daily Log</h3>
					<a class="new-button" href={resolve('/journal')}
						>{data.dailyLog ? 'Open log' : 'New entry'} ↗</a
					>
				</div>
				{#if data.dailyLog}
					<a class="journal-preview" href={resolve('/journal')}
						><span class="eyebrow">{dateLabel(data.today)} · Your daily log</span><strong
							>{data.dailyLog.highlight || data.dailyLog.mood || 'A moment from today'}</strong
						><span
							>{data.dailyLog.gratitude ||
								data.dailyLog.note?.slice(0, 180) ||
								'Make a little room for reflection.'}</span
						></a
					>
				{:else}
					<a class="new-page" href={resolve('/journal')}>＋ Start today's log</a>
				{/if}
				<img
					class="dopamine"
					src={`${base}/images/home/dopamine-menu.png`}
					alt="Dopamine menu: put on a favourite song, read a chapter, cozy up with a drink, do a crossword, look at saved photos, cuddle a pet, paint or create, or step outside for a minute."
					width="1774"
					height="742"
					loading="lazy"
				/>
				<div class="database-header task-header">
					<h3><Icon name="tasks" size={18} /> Due today <span class="count">{openToday}</span></h3>
					<a class="quiet-link" href={resolve(appPath('/tasks?view=today'))}>All tasks ↗</a>
				</div>
				{#if data.dueToday.length === 0}<p class="empty-inline">
						Nothing due today. Leave a little room to breathe.
					</p>
				{:else}
					<ul class="task-list" aria-label="Tasks due today">
						{#each data.dueToday as task (task.id)}
							<li class:done={isDone(task.status)}>
								<form method="POST" action="?/toggleTask" use:enhance>
									<input type="hidden" name="id" value={task.id} />
									<input type="hidden" name="updatedAt" value={task.updatedAt.toISOString()} />
									<input type="hidden" name="done" value={isDone(task.status) ? 'false' : 'true'} />
									<button
										class="tick"
										type="submit"
										aria-pressed={isDone(task.status)}
										aria-label={isDone(task.status)
											? `Reopen ${task.title}`
											: `Complete ${task.title}`}>{isDone(task.status) ? '✓' : ''}</button
									>
								</form>
								<a href={resolve(appPath(`/tasks/${task.id}`))}>{task.title}</a>
								{#if task.isImportant}<span class="important" title="Important">✦</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="daily-details" id="daily-details" aria-labelledby="details-heading">
				<h2 id="details-heading">⊕ Daily details</h2>
				<p class="section-note blue-note">The small stuff that adds up.</p>
				<div class="habits-panel">
					<div class="habits-heading">
						<a class="view-label" href={resolve('/habits')}
							><Icon name="habits" size={14} /> Habits</a
						><span class="count">{habitsDone}/{data.habits.length}</span>
					</div>
					{#if data.habits.length === 0}<div class="empty-habits">
							<Icon name="habits" size={24} />
							<p>Make room for a small ritual.</p>
							<a href={resolve('/habits')}>Create your first habit ↗</a>
						</div>
					{:else}<ul class="habit-list" aria-label="Habits for today">
							{#each data.habits as habit (habit.id)}
								<li class:logged={habit.doneToday}>
									<a class="habit-name" href={resolve(appPath(`/habits/${habit.id}`))}
										><span class="habit-marker">{habit.doneToday ? '✓' : '↻'}</span>{habit.name}</a
									>
									<div class="habit-bottom">
										<form method="POST" action="?/toggleHabit" use:enhance>
											<input type="hidden" name="id" value={habit.id} /><input
												type="hidden"
												name="day"
												value={data.today}
											/><input
												type="hidden"
												name="done"
												value={habit.doneToday ? 'false' : 'true'}
											/><button
												type="submit"
												aria-pressed={habit.doneToday}
												aria-label={habit.doneToday ? `Undo ${habit.name}` : `Log ${habit.name}`}
												>{habit.doneToday ? '✓ Logged today' : 'Log Today'}</button
											>
										</form>
										{#if habit.streak > 0}<span class="streak">{habit.streak}d streak</span>{/if}
									</div>
								</li>
							{/each}
						</ul>{/if}
					<a class="new-page" href={resolve('/habits')}>＋ New habit</a>
				</div>

				{#if hasHealthSignal}
					<div class="health-panel">
						<div class="habits-heading">
							<a class="view-label" href={resolve(appPath('/health'))}
								><Icon name="habits" size={14} /> Today's health</a
							>
						</div>

						{#if dueMedications.length > 0}
							<ul class="health-med-list" aria-label="Medications due today">
								{#each dueMedications as medication (medication.id)}
									<DueMedicationRow {medication} />
								{/each}
							</ul>
						{/if}

						<p class="health-line">
							{#if data.health.measurements.latestOverall}
								<span>{summaryOf(data.health.measurements.latestOverall)}</span>
							{:else}
								<span class="muted">No readings yet</span>
							{/if}
							<a href={resolve(appPath('/health/measurements'))}>Add a reading ↗</a>
						</p>

						{#if data.health.visits.next}
							<p class="health-line">
								<span>Next visit: {data.health.visits.next.reason}</span>
								<span class="health-visit-when">{visitWhen(data.health.visits.next.visitAt)}</span>
							</p>
						{/if}
					</div>
				{/if}
			</section>
		</div>

		<section class="home-section" id="on-the-horizon" aria-labelledby="horizon-heading">
			<h2 id="horizon-heading">📅 On the horizon</h2>
			<p class="section-note brown">The things Future Me would rather not be surprised by.</p>
			<div class="horizon-grid">
				<div>
					<HomeCalendar
						today={data.today}
						month={data.today.slice(0, 7)}
						tasks={data.calendarTasks}
						dates={data.calendarDates}
					/>
					<p class="calendar-caption">
						Scheduled household tasks and dates ·
						<a href={resolve(appPath('/calendar'))}>Open full calendar ↗</a>
					</p>
				</div>
				<div class="horizon-aside">
					<section class="weather">
						<h3>Weather</h3>
						{#if data.weather.status === 'ok' && data.weather.current}
							<div class="weather-card">
								<span class="weather-symbol" aria-hidden="true">{data.weather.current.icon}</span>
								<div>
									<strong>{data.weather.locationLabel}</strong>
									<p class="weather-reading">
										{Math.round(data.weather.current.temperature)}° · {data.weather.current.label}
									</p>
									<p class="weather-details">
										Feels like {Math.round(data.weather.current.feelsLike)}° · Wind {Math.round(
											data.weather.current.windSpeed
										)}
										{data.weather.units === 'metric' ? 'km/h' : 'mph'}
									</p>
									<span class="soon-label">Live forecast · Open-Meteo</span>
								</div>
							</div>
						{:else if data.weather.status === 'not_configured'}
							<div class="weather-card weather-setup">
								<span class="weather-symbol" aria-hidden="true">☼</span>
								<div>
									<strong>Set your local forecast</strong>
									<p>Add weather coordinates to the server environment.</p>
									<span class="soon-label">LIFEOS_WEATHER_LATITUDE + LONGITUDE</span>
								</div>
							</div>
						{:else}
							<div class="weather-card weather-setup">
								<span class="weather-symbol" aria-hidden="true">☁</span>
								<div>
									<strong>{data.weather.locationLabel}</strong>
									<p>The forecast is taking a little longer than usual.</p>
									<span class="soon-label">Try refreshing in a moment</span>
								</div>
							</div>
						{/if}
					</section>
					<section class="important-dates">
						<h3>Dates to remember</h3>
						{#if data.upcomingDates.length === 0}<p class="empty-inline">
								No upcoming dates in the next 30 days.
							</p>{:else}<ul>
								{#each data.upcomingDates as date (date.record.id)}<li>
										<span>◷</span><span>{date.record.title}</span><time datetime={date.nextOn}
											>{dateLabel(date.nextOn)}</time
										>
									</li>{/each}
							</ul>{/if}
					</section>
				</div>
			</div>
		</section>

		<section class="home-section" id="jump-back-in" aria-labelledby="jump-heading">
			<h2 id="jump-heading">🧭 Jump back in</h2>
			<p class="section-note rose">Pick up wherever life needs you.</p>
			<div class="jump-grid">
				{#each jumpGroups as group (group.label)}
					<section class="jump-card">
						<h3>{group.symbol} {group.label}</h3>
						<ul>
							{#each group.links as link (link.label)}<li>
									{#if link.href}<a href={resolve(appPath(link.href))}
											><span>{link.symbol}</span><span>{link.label}</span></a
										>{:else}<span class="unavailable"
											><span>{link.symbol}</span><span>{link.label}</span><small>Soon</small></span
										>{/if}
								</li>{/each}
						</ul>
					</section>
				{/each}
			</div>
		</section>

		<section class="home-section" id="right-now" aria-labelledby="now-heading">
			<div class="section-title">
				<h2 id="now-heading">🎧 Right now</h2>
				<span class="soon-label">Coming soon</span>
			</div>
			<p class="section-note purple">Currently occupying my attention.</p>
			<div class="now-grid">
				{#each [{ label: 'Reading', icon: '📖', description: 'A book to get lost in.' }, { label: 'Watching', icon: '🎞️', description: 'One more episode.' }, { label: 'Listening', icon: '🎧', description: 'The soundtrack to your days.' }, { label: 'Playing', icon: '🎮', description: 'A little time just for fun.' }] as item (item.label)}
					<div class="now-item">
						<h3>{item.label}</h3>
						<div class="now-placeholder">
							<span>{item.icon}</span>
							<p>{item.description}</p>
						</div>
					</div>
				{/each}
			</div>
		</section>

		<section
			class="home-section archives"
			id="from-the-archives"
			aria-labelledby="archives-heading"
		>
			<h2 id="archives-heading">✨ From the archives</h2>
			<p class="section-note blue-note">Something worth finding again.</p>
			<div class="archive-grid">
				<section>
					<h3 class="archive-heading"><Icon name="journal" size={15} /> Recent journal</h3>
					{#if data.recentJournal.length === 0}<a class="archive-empty" href={resolve('/journal')}
							>Your story starts with a day.<span>Write a journal entry ↗</span></a
						>{:else}<ul class="revisit-list">
							{#each data.recentJournal as entry (entry.id)}<li>
									<a href={resolve(appPath(`/journal/${entry.onDate}`))}
										><time datetime={entry.onDate}>{dateLabel(entry.onDate)}</time><strong
											>{entry.highlight || entry.mood || 'Daily reflection'}</strong
										></a
									>
								</li>{/each}
						</ul>{/if}
				</section>
				<section>
					<h3 class="archive-heading"><Icon name="projects" size={15} /> Projects in motion</h3>
					{#if data.activeProjects.length === 0}<a class="archive-empty" href={resolve('/projects')}
							>A little progress goes a long way.<span>Explore your projects ↗</span></a
						>{:else}<ul class="revisit-list">
							{#each data.activeProjects as project (project.id)}<li>
									<a href={resolve(appPath(`/projects/${project.id}`))}
										><span class="eyebrow">Active project</span><strong>{project.name}</strong></a
									>
								</li>{/each}
						</ul>{/if}
				</section>
				<section>
					<h3 class="archive-heading"><Icon name="goals" size={15} /> Worth revisiting</h3>
					{#if data.activeGoals.length === 0}<a class="archive-empty" href={resolve('/goals')}
							>Keep what matters in sight.<span>Explore your goals ↗</span></a
						>{:else}<ul class="revisit-list">
							{#each data.activeGoals as goal (goal.id)}<li>
									<a href={resolve(appPath(`/goals/${goal.id}`))}
										><span class="eyebrow">Active goal</span><strong>{goal.title}</strong></a
									>
								</li>{/each}
						</ul>{/if}
				</section>
			</div>
		</section>

		<footer class="home-footer">
			<span>Make a life worth remembering.</span><a href={resolve('/account/credentials')}
				><img src={`${base}/images/home/settings-icon.png`} alt="" width="20" height="20" /> Account settings</a
			>
		</footer>
	</div>
</div>

<style>
	.home {
		--home-muted: var(--c-text-muted);
	}
	.cover {
		height: clamp(180px, 16vw, 300px);
		overflow: hidden;
		background: #473a28;
	}
	.cover img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: 50% 37%;
	}
	.home-content {
		width: 89%;
		max-width: 1712px;
		margin: 0 auto;
	}
	.home-heading {
		position: relative;
		padding-top: 67px;
		border-bottom: 1px solid var(--c-border);
		margin-bottom: 14px;
	}
	.page-icon {
		position: absolute;
		top: -37px;
		left: 0;
		object-fit: contain;
	}
	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		padding-bottom: 19px;
	}
	h1 {
		margin: 0;
		font-size: clamp(2rem, 2.5vw, 2.6rem);
		letter-spacing: -0.03em;
		font-weight: 720;
	}
	.welcome {
		font-size: 0.8rem;
		color: var(--home-muted);
	}
	.memento {
		display: block;
		width: 100%;
		height: auto;
		border-radius: 2px;
	}
	.daily-grid {
		display: grid;
		grid-template-columns: minmax(180px, 0.82fr) minmax(0, 2.2fr) minmax(210px, 1fr);
		align-items: start;
		gap: 3.5%;
		margin-top: 28px;
	}
	.overview {
		display: flex;
		flex-direction: column;
		gap: 13px;
		min-width: 0;
	}
	h2 {
		margin: 13px 0 14px;
		font-size: 1.15rem;
		letter-spacing: -0.015em;
		font-weight: 650;
	}
	h3 {
		font-size: 1rem;
		font-weight: 600;
	}
	.section-note {
		max-width: none;
		margin: 0 0 14px;
		padding: 3px 6px;
		border-radius: 5px;
		color: #f4eee9;
		font-size: 0.88rem;
		line-height: 1.5;
		font-style: italic;
	}
	.gold {
		background: #514727;
	}
	.blue-note {
		background: #23394f;
	}
	.brown {
		background: #563820;
	}
	.rose {
		background: #4f2e40;
	}
	.purple {
		background: #3e304c;
	}
	.view-label {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		width: fit-content;
		padding: 5px 10px;
		border-radius: 20px;
		background: var(--c-surface-alt);
		color: var(--c-text);
		font-size: 0.8rem;
		text-decoration: none;
	}
	.command-center {
		padding: 14px 13px 17px;
		border: 1px solid var(--c-border);
		border-radius: 9px;
		background: var(--c-surface);
	}
	.command-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 0.85rem;
	}
	.command-center h3 {
		margin: 21px 0 5px;
		font-size: 0.66rem;
		letter-spacing: 0.025em;
		text-transform: uppercase;
	}
	.status-line {
		display: flex;
		align-items: baseline;
		gap: 5px;
		padding: 2px 0;
		color: var(--home-muted);
		font-size: 0.72rem;
		text-decoration: none;
	}
	.status-line:hover {
		text-decoration: underline;
	}
	.arrow {
		margin-left: auto;
	}
	.overdue {
		color: var(--c-crit);
	}
	.amber {
		color: var(--c-warn);
	}
	.blue {
		color: var(--c-accent);
	}
	.green {
		color: var(--c-ok);
	}
	.mauve {
		color: #af87b8;
	}
	.menu-panel {
		padding: 10px 13px;
		border: 1px solid var(--c-border);
		border-radius: 8px;
	}
	summary {
		min-height: 44px;
		align-content: center;
		cursor: pointer;
		font-weight: 600;
		font-size: 0.95rem;
	}
	summary img {
		vertical-align: middle;
	}
	.capture-links {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding-top: 10px;
		border-top: 1px solid var(--c-border);
	}
	.capture-links button,
	.capture-links a {
		display: flex;
		align-items: center;
		gap: 7px;
		width: fit-content;
		max-width: 100%;
		min-height: 36px;
		padding: 4px 9px;
		border: 1px solid var(--c-border);
		border-radius: 5px;
		background: transparent;
		color: var(--c-text);
		font-size: 0.78rem;
		text-decoration: none;
		text-align: left;
		cursor: pointer;
	}
	.capture-links button:hover,
	.capture-links a:hover {
		background: var(--c-surface-alt);
	}
	.unavailable {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--home-muted);
		font-size: 0.8rem;
		line-height: 1.5;
	}
	.unavailable small {
		margin-left: auto;
		padding: 0 4px;
		border: 1px solid var(--c-border);
		border-radius: 3px;
		color: var(--home-muted);
		font-size: 0.6rem;
		white-space: nowrap;
	}
	.workspace-groups {
		padding-bottom: 10px;
	}
	.workspace-groups h3 {
		margin: 24px 0 8px;
		font-size: 0.78rem;
		text-transform: uppercase;
	}
	.workspace-groups a {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 6px 0;
		color: var(--c-text);
		font-size: 0.82rem;
		text-decoration-color: var(--c-border);
		text-underline-offset: 3px;
	}
	.workspace-groups .unavailable {
		padding: 6px 0;
	}
	.database-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-top: 13px;
		margin-bottom: 14px;
		border-top: 1px solid var(--c-border);
	}
	.database-header h3 {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 1.1rem;
	}
	.new-button {
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 36px;
		padding: 7px 10px;
		border-radius: 5px;
		background: #267bc1;
		color: white;
		font-size: 0.75rem;
		text-decoration: none;
	}
	.new-button:hover {
		background: #318dd8;
	}
	.new-page {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 39px;
		border: 1px solid var(--c-border);
		border-radius: 8px;
		color: var(--home-muted);
		font-size: 0.8rem;
		text-decoration: none;
	}
	.today > .new-page {
		max-width: 260px;
		margin-bottom: 13px;
	}
	.new-page:hover {
		background: var(--c-surface-alt);
		color: var(--c-text);
	}
	.journal-preview {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 14px;
		margin-bottom: 14px;
		border: 1px solid var(--c-border);
		border-radius: 7px;
		color: var(--c-text);
		font-size: 0.85rem;
		text-decoration: none;
	}
	.journal-preview > span:last-child {
		color: var(--home-muted);
	}
	.eyebrow {
		color: var(--home-muted);
		font-size: 0.7rem;
		font-weight: 400;
	}
	.dopamine {
		display: block;
		width: 100%;
		height: auto;
		border-radius: 2px;
	}
	.task-header {
		margin-top: 22px;
	}
	.task-header h3 {
		font-size: 0.95rem;
	}
	.count {
		color: var(--home-muted);
		font-size: 0.74rem;
		font-variant-numeric: tabular-nums;
	}
	.quiet-link {
		color: var(--home-muted);
		font-size: 0.72rem;
		text-decoration: none;
	}
	.empty-inline {
		margin: 15px 0;
		color: var(--home-muted);
		font-size: 0.82rem;
	}
	.task-list,
	.habit-list,
	.jump-card ul,
	.important-dates ul,
	.revisit-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.task-list li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 0;
		border-bottom: 1px solid var(--c-border);
		font-size: 0.85rem;
	}
	.task-list a {
		color: var(--c-text);
		text-decoration: none;
	}
	.task-list .done a {
		color: var(--home-muted);
		text-decoration: line-through;
	}
	.tick {
		position: relative;
		width: 34px;
		height: 36px;
		min-height: 36px;
		border: 0;
		background: transparent;
		color: var(--c-ok);
		cursor: pointer;
	}
	.tick::before {
		position: absolute;
		inset: 9px 8px;
		border: 1px solid var(--home-muted);
		border-radius: 4px;
		content: '';
	}
	.tick[aria-pressed='true']::before {
		border-color: var(--c-ok);
	}
	.important {
		margin-left: auto;
		color: var(--c-warn);
	}
	.habits-panel {
		padding: 16px;
		border-radius: 9px;
		background: var(--c-surface-alt);
	}
	.habits-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 15px;
	}
	.habits-heading .view-label {
		background: var(--c-surface);
	}
	.habit-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 14px;
	}
	.habit-list li {
		padding: 13px 11px;
		border: 1px solid var(--c-border);
		border-radius: 9px;
		background: color-mix(in srgb, var(--c-surface-alt), var(--c-text) 7%);
	}
	.habit-name {
		display: flex;
		align-items: baseline;
		gap: 9px;
		color: var(--c-text);
		font-size: 0.84rem;
		text-decoration: none;
	}
	.habit-marker {
		color: var(--c-ok);
		font-weight: 600;
	}
	.habit-bottom {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 7px;
		margin-top: 9px;
	}
	.habit-bottom button {
		min-height: 30px;
		padding: 2px 6px;
		border: 1px solid color-mix(in srgb, var(--c-text), transparent 75%);
		border-radius: 4px;
		background: transparent;
		font-size: 0.75rem;
		cursor: pointer;
	}
	.habit-bottom button:hover {
		background: var(--c-surface);
	}
	.logged button {
		color: var(--c-ok);
	}
	.streak {
		color: var(--home-muted);
		font-size: 0.65rem;
	}
	.empty-habits {
		padding: 20px 4px 28px;
		color: var(--home-muted);
		font-size: 0.83rem;
	}
	.empty-habits p {
		margin: 12px 0 6px;
	}
	.empty-habits a {
		color: var(--c-text);
	}
	.health-panel {
		margin-top: 14px;
		padding: 16px;
		border-radius: 9px;
		background: var(--c-surface-alt);
	}
	.health-med-list {
		margin: 0 0 10px;
		padding: 0;
		list-style: none;
	}
	.health-med-list :global(li + li) {
		border-top: 1px solid var(--c-border);
	}
	.health-line {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		margin: 8px 0 0;
		font-size: 0.82rem;
	}
	.health-line a {
		flex: none;
		color: var(--c-accent);
		font-size: 0.74rem;
		text-decoration: none;
		white-space: nowrap;
	}
	.health-line a:hover {
		text-decoration: underline;
	}
	.health-line .muted {
		color: var(--home-muted);
	}
	.health-visit-when {
		flex: none;
		color: var(--home-muted);
		font-size: 0.74rem;
		white-space: nowrap;
	}
	.home-section {
		margin-top: 58px;
		scroll-margin-top: 70px;
	}
	.today,
	.daily-details {
		scroll-margin-top: 70px;
	}
	.home-section > .section-note {
		margin-bottom: 25px;
	}
	.horizon-grid {
		display: grid;
		grid-template-columns: minmax(0, 2.2fr) minmax(240px, 1fr);
		gap: 3.5%;
		padding-top: 24px;
		border-top: 1px solid var(--c-border);
	}
	.calendar-caption {
		margin: 9px 0 0;
		color: var(--home-muted);
		font-size: 0.7rem;
	}
	.calendar-caption a {
		color: inherit;
	}
	.horizon-aside {
		display: flex;
		flex-direction: column;
		gap: 27px;
	}
	.horizon-aside h3 {
		padding: 8px 0 14px;
		margin-bottom: 13px;
		border-bottom: 1px solid var(--c-border);
		font-size: 0.93rem;
		text-transform: uppercase;
	}
	.weather h3 {
		color: var(--c-accent);
	}
	.important-dates h3 {
		color: var(--c-warn);
	}
	.weather-card {
		display: flex;
		align-items: center;
		gap: 18px;
		min-height: 145px;
		padding: 20px;
		border-radius: 2px;
		background: #f3efe7;
		color: #413d35;
	}
	.weather-symbol {
		color: #b2863c;
		font-size: 2.8rem;
	}
	.weather-card strong {
		font-size: 0.87rem;
	}
	.weather-card p {
		margin: 4px 0 10px;
		font-size: 0.78rem;
	}
	.weather-card .weather-reading {
		margin-bottom: 3px;
		font-size: 1.05rem;
		font-variant-numeric: tabular-nums;
	}
	.weather-card .weather-details {
		margin-bottom: 10px;
		color: #625c50;
		font-size: 0.7rem;
	}
	.weather-setup {
		align-items: flex-start;
	}
	.soon-label {
		display: inline-block;
		padding: 2px 6px;
		border: 1px solid var(--c-border);
		border-radius: 4px;
		color: var(--home-muted);
		font-size: 0.65rem;
	}
	.weather-card .soon-label {
		border-color: #d8d0c0;
		color: #625c50;
	}
	.important-dates li {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 11px 0;
		font-size: 0.8rem;
	}
	.important-dates time {
		margin-left: auto;
		color: var(--home-muted);
		white-space: nowrap;
	}
	.jump-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 3.5%;
		padding-top: 24px;
		border-top: 1px solid var(--c-border);
	}
	.jump-card {
		padding: 20px 18px 23px;
		border: 1px solid var(--c-border);
		border-radius: 9px;
	}
	.jump-card h3 {
		padding-bottom: 14px;
		margin-bottom: 12px;
		border-bottom: 1px solid var(--c-border);
		text-transform: uppercase;
	}
	.jump-card a {
		display: flex;
		gap: 7px;
		padding: 5px 0;
		color: var(--c-text);
		font-size: 0.84rem;
		text-decoration-color: var(--c-border);
		text-underline-offset: 3px;
	}
	.jump-card a:hover {
		color: var(--c-accent);
		text-decoration-color: currentColor;
	}
	.jump-card .unavailable {
		padding: 5px 0;
	}
	.jump-card .unavailable > span:nth-child(2) {
		flex: 1;
	}
	.section-title {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.section-title h2 {
		margin-bottom: 14px;
	}
	.section-title .soon-label {
		margin-bottom: 2px;
	}
	.now-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 3.5%;
	}
	.now-item h3 {
		margin: 12px 0 15px;
		font-size: 0.93rem;
	}
	.now-placeholder {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 20px 13px;
		border: 1px dashed var(--c-border);
		border-radius: 6px;
		color: var(--home-muted);
	}
	.now-placeholder > span {
		font-size: 1.4rem;
		opacity: 0.6;
	}
	.now-placeholder p {
		margin: 0;
		font-size: 0.77rem;
	}
	.archive-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 3.5%;
	}
	.archive-heading {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 15px;
		font-size: 0.88rem;
	}
	.archive-empty {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 20px 16px;
		border: 1px solid var(--c-border);
		border-radius: 7px;
		color: var(--home-muted);
		font-size: 0.8rem;
		text-decoration: none;
	}
	.archive-empty span {
		color: var(--c-text);
		font-size: 0.75rem;
	}
	.revisit-list li {
		border-bottom: 1px solid var(--c-border);
	}
	.revisit-list a {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 11px 3px;
		color: var(--c-text);
		font-size: 0.85rem;
		text-decoration: none;
	}
	.revisit-list time {
		color: var(--home-muted);
		font-size: 0.7rem;
	}
	.revisit-list strong {
		font-weight: 500;
	}
	.home-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 22px 0 35px;
		margin-top: 65px;
		border-top: 1px solid var(--c-border);
		color: var(--home-muted);
		font-size: 0.72rem;
	}
	.home-footer > span {
		font-family: Georgia, serif;
		font-style: italic;
	}
	.home-footer a {
		display: flex;
		align-items: center;
		gap: 7px;
		color: inherit;
		text-decoration: none;
	}
	.notice {
		padding: 12px;
		margin: 18px 0;
		border: 1px solid var(--c-crit);
		color: var(--c-crit);
	}
	@media (max-width: 1100px) {
		.home-content {
			width: 92%;
		}
		.daily-grid {
			grid-template-columns: minmax(170px, 0.8fr) minmax(0, 1.6fr);
			gap: 22px;
		}
		.daily-details {
			grid-column: 2;
		}
		.overview {
			grid-row: 1 / span 2;
		}
		.jump-grid,
		.now-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 20px;
		}
		.horizon-grid {
			grid-template-columns: minmax(0, 1fr);
		}
		.horizon-aside {
			display: grid;
			grid-template-columns: 1fr 1fr;
			margin-top: 24px;
		}
		.welcome {
			display: none;
		}
	}
	@media (max-width: 600px) {
		.home-content {
			width: auto;
			margin: 0 18px;
		}
		.cover {
			height: 175px;
		}
		.cover img {
			object-position: 43% 38%;
		}
		.home-heading {
			padding-top: 46px;
		}
		.page-icon {
			top: -30px;
			width: 60px;
			height: 60px;
		}
		.title-row {
			padding-bottom: 14px;
		}
		.memento {
			margin-bottom: 23px;
		}
		.daily-grid {
			display: flex;
			flex-direction: column;
			gap: 28px;
			margin-top: 18px;
		}
		.daily-grid > * {
			width: 100%;
		}
		.today {
			order: 0;
		}
		.daily-details {
			order: 1;
		}
		.overview {
			order: 2;
		}
		.home-section {
			margin-top: 39px;
		}
		h2 {
			font-size: 1.05rem;
		}
		.horizon-aside {
			grid-template-columns: 1fr;
			gap: 15px;
		}
		.jump-grid,
		.archive-grid {
			grid-template-columns: 1fr;
			gap: 16px;
		}
		.jump-card {
			padding: 18px;
		}
		.jump-card a,
		.jump-card .unavailable {
			min-height: 42px;
		}
		.now-grid {
			gap: 18px;
		}
		.now-placeholder {
			align-items: flex-start;
			flex-direction: column;
			padding: 17px 12px;
		}
		.new-button,
		.habit-bottom button,
		.tick,
		.capture-links button,
		.capture-links a {
			min-height: 44px;
		}
		.tick {
			width: 40px;
		}
		.tick::before {
			inset: 12px 10px;
		}
		.home-footer {
			align-items: flex-start;
			flex-direction: column;
			margin-top: 40px;
		}
		.calendar-caption {
			line-height: 1.7;
		}
		.command-center {
			padding: 18px;
		}
		.status-line {
			padding: 5px 0;
			font-size: 0.85rem;
		}
	}
</style>
