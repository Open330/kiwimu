export interface Citation {
  id: number;
  page_id: number;
  source_id: number;
  source_page_id: number | null;
  excerpt: string | null;
  context: string | null;
  created_at: string;
  // Joined fields are populated only by the corresponding joined projections.
  source_title?: string;
  source_page_title?: string;
  source_page_slug?: string;
  page_title?: string;
  page_slug?: string;
}

export interface Quiz {
  id: number;
  page_id: number;
  question: string;
  answer: string;
  explanation: string;
  quiz_type: string;
  ease_factor: number;
  interval: number;
  next_review_at: string | null;
  created_at: string;
  page_title?: string;
  page_slug?: string;
}

export interface ActivityLogEntry {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  title: string;
  details: string | null;
  created_at: string;
}

export interface SourceCoverage {
  sourceId: number;
  sourceTitle: string;
  citationCount: number;
  pageCount: number;
}

export interface LearningStats {
  total: number;
  mastered: number;
  learning: number;
  new: number;
  dueToday: number;
}

export interface QuizStats {
  total: number;
  correct: number;
  incorrect: number;
  unattempted: number;
}

export interface WeakConcept {
  title: string;
  slug: string;
  wrongCount: number;
}

export interface QuizHistoryEntry {
  quiz_id: number;
  question: string;
  is_correct: boolean;
  attempted_at: string;
}

export interface UsageSummary {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface ActivityStats {
  total: number;
  byAction: Record<string, number>;
  recentDays: Array<{ date: string; count: number }>;
}
