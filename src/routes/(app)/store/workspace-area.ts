import { sql } from '$lib/server/db';
import { listAreas, listProjects, listTasks, type Viewer } from '$lib/server/repositories';

/**
 * A workspace page backed by one life area.
 *
 * The source's "Etsy Store Manager" and "Content Creation" pages are empty
 * shells — `Databases: No`, and a body containing nothing but the shared
 * navigation bar. Neither has ever held a record.
 *
 * So neither gets an invented feature set. What the store genuinely has is an
 * AREA called "Etsy Store", with projects and tasks already filed under it,
 * and showing that is the honest version of the page: the work exists, it was
 * simply never in the dashboard.
 *
 * Matched by name rather than by id because the id differs per install, and
 * looked up leniently so a rename to "Etsy shop" still finds it. When nothing
 * matches, the caller says so instead of showing an empty frame that implies
 * the feature is broken.
 */
export async function areaWorkspace(viewer: Viewer, needles: readonly string[]) {
	const areas = await listAreas(sql, viewer, { limit: 200 });
	const area =
		areas.find((a) => needles.some((n) => a.name.toLowerCase().includes(n.toLowerCase()))) ?? null;

	if (!area) return { area: null, projects: [], tasks: [] };

	const [projects, tasks] = await Promise.all([
		listProjects(sql, viewer, { areaId: area.id, order: 'due', limit: 100 }),
		listTasks(sql, viewer, { areaId: area.id, status: 'open', order: 'due', limit: 100 })
	]);

	return {
		area: { id: area.id, name: area.name, description: area.description },
		projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status, dueOn: p.dueOn })),
		tasks: tasks.map((t) => ({ id: t.id, title: t.title, doOn: t.doOn, status: t.status }))
	};
}
