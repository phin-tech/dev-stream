export type FilterDimension = "source" | "project" | "repo" | "kind" | "tag";

export function nextFilterOptionIndex(
  current: number,
  direction: 1 | -1,
  count: number,
): number {
  if (count <= 0) return -1;
  return (current + direction + count) % count;
}

export function typeaheadFilterOptionIndex(
  values: string[],
  current: number,
  query: string,
): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || values.length === 0) return -1;
  for (let offset = 1; offset <= values.length; offset += 1) {
    const index = (current + offset + values.length) % values.length;
    if (values[index].toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
