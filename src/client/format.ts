// Turning stored integers back into what the user typed, for the edit form.

/** 3000 → "30.00" */
export function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** 3333 → "33.33", 5000 → "50" */
export function bpToInput(bp: number): string {
  const decimals = bp % 100;
  return decimals === 0 ? String(bp / 100) : `${Math.floor(bp / 100)}.${String(decimals).padStart(2, '0')}`;
}
