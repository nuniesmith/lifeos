<script lang="ts">
	import WorkspacePage from '$lib/components/WorkspacePage.svelte';
	import { workspacePageFor } from '$lib/components/workspace-pages';

	const page = workspacePageFor('review');
</script>

<WorkspacePage {...page} />
