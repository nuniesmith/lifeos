<script lang="ts">
	import WorkspacePage from '$lib/components/WorkspacePage.svelte';
	import { workspacePageFor } from '$lib/components/workspace-pages';

	const page = workspacePageFor('finance');
</script>

<WorkspacePage {...page} />
