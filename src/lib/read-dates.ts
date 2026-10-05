/**
 * How much of a stored read date is real (migration 0037). StoryGraph
 * records many reads by year only ("2019") or by year and month ("2019/05"),
 * so an imported read stores the first day of that period in its `date`
 * column and says here how much of it to believe. Everything logged in the
 * app itself is `day`, the column's default.
 */
export const DATE_PRECISIONS = ['day', 'month', 'year'] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/**
 * A stored day shown only as precisely as it is known: `2019-05-03` reads as
 * `2019` for a year-only date and `2019-05` for a month-only one. Without
 * this, a year-only read would claim to have finished on 1 January.
 */
export function readDayLabel(day: string, precision: DatePrecision): string {
	if (precision === 'year') return day.slice(0, 4);
	if (precision === 'month') return day.slice(0, 7);
	return day;
}
