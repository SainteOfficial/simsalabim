import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn-Konvention: Klassen zusammenführen, spätere Tailwind-Klassen gewinnen. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
