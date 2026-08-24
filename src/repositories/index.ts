export { ActivityRepository } from "./activity-repository";
export { CitationRepository } from "./citation-repository";
export {
  ContentFenceRepository,
  StaleContentFenceError,
  directContentMutations,
} from "./content-fence-repository";
export { QuizRepository } from "./quiz-repository";
export type {
  ContentFence,
  ContentMutationRunner,
  FenceIdentity,
} from "./content-fence-repository";
export type {
  ActivityLogEntry,
  ActivityStats,
  Citation,
  LearningStats,
  Quiz,
  QuizHistoryEntry,
  QuizStats,
  SourceCoverage,
  UsageSummary,
  WeakConcept,
} from "./domain-types";
