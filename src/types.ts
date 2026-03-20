export type MealType = 'lunch' | 'dinner';

export interface MealEntry {
  id: string;
  date: string; // ISO string YYYY-MM-DD
  type: MealType;
  name: string;
  recipeUrl?: string;
}
