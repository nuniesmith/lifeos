<script lang="ts">
	import JournalDay from '../JournalDay.svelte';

	let { data, form } = $props();
</script>

<JournalDay {data} {form} />
