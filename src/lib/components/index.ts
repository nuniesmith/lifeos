/**
 * The shared component library.
 *
 * Import from `$lib/components` rather than reaching for a file path, so a
 * component can be renamed or split without touching every route that uses it.
 */

export { default as Badge } from './Badge.svelte';
export { default as BottomNav } from './BottomNav.svelte';
export { default as Button } from './Button.svelte';
export { default as Card } from './Card.svelte';
export { default as Checkbox } from './Checkbox.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as ErrorState } from './ErrorState.svelte';
export { default as Field } from './Field.svelte';
export { default as Icon } from './Icon.svelte';
export { default as Input } from './Input.svelte';
export { default as LibraryList } from './LibraryList.svelte';
export { default as List } from './List.svelte';
export { default as ListRow } from './ListRow.svelte';
export { default as LoadingState } from './LoadingState.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as QuickAdd } from './QuickAdd.svelte';
export { default as Select } from './Select.svelte';
export { default as Sheet } from './Sheet.svelte';
export { default as SideNav } from './SideNav.svelte';
export { default as Tag } from './Tag.svelte';
export { default as Textarea } from './Textarea.svelte';

export type { FieldContext } from './Field.svelte';
export type { Option } from './Select.svelte';
export type { ShelfItem } from './LibraryList.svelte';
export { ICONS, type IconName } from './icons';
export {
	ADMIN_DESTINATIONS,
	APP_DESTINATIONS,
	BAR_DESTINATIONS,
	OVERFLOW_DESTINATIONS,
	adminDestinationsFor,
	appPath,
	isCurrent,
	type Destination
} from './nav';
