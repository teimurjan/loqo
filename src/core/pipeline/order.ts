export type Positioned = { position: number; name: string };

/** The one ordering of pipeline steps: by position, then by name so equal positions stay stable. Pure, so the flow page shares it. */
export const byPosition = (a: Positioned, b: Positioned): number => a.position - b.position || a.name.localeCompare(b.name);
