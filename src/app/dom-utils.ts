/** Tiny helpers for reading values out of DOM events in templates' handlers. */

export const readNumber = (event: Event): number => Number((event.target as HTMLInputElement).value);

export const readChecked = (event: Event): boolean => (event.target as HTMLInputElement).checked;

export const readValue = (event: Event): string => (event.target as HTMLInputElement | HTMLSelectElement).value;