import type { Database } from "bun:sqlite";
import type { ActivityRepository } from "./activity-repository";
import type {
  LearningStats,
  Quiz,
  QuizHistoryEntry,
  QuizStats,
  WeakConcept,
} from "./domain-types";
import {
  directContentMutations,
  type ContentMutationRunner,
} from "./content-fence-repository";

interface CountRow {
  count: number;
}

interface QuizScheduleRow {
  ease_factor: number;
  interval: number;
}

interface QuizQuestionRow {
  question: string;
}

interface AttemptSummaryRow {
  total: number;
  correct: number;
  incorrect: number;
}

interface QuizHistoryRow {
  quiz_id: number;
  question: string;
  is_correct: number;
  attempted_at: string;
}

/** Quiz persistence, attempts, and SM-2 scheduling over Store's shared database. */
export class QuizRepository {
  constructor(
    private readonly db: Database,
    private readonly activities: ActivityRepository,
    private readonly mutations: ContentMutationRunner = directContentMutations,
  ) {}

  addQuiz(
    pageId: number,
    question: string,
    answer: string,
    quizType: string,
    explanation: string = "",
  ): void {
    this.mutations.run(() => {
      this.db.prepare(
        "INSERT INTO quizzes (page_id, question, answer, explanation, quiz_type) VALUES (?, ?, ?, ?, ?)",
      ).run(pageId, question, answer, explanation, quizType);
    });
  }

  getQuizzesByPage(pageId: number): Quiz[] {
    return this.db.prepare(
      `SELECT q.*, p.title as page_title, p.slug as page_slug
       FROM quizzes q JOIN pages p ON p.id = q.page_id
       WHERE q.page_id = ? ORDER BY q.id`,
    ).all(pageId) as Quiz[];
  }

  getAllQuizzes(): Quiz[] {
    return this.db.prepare(
      `SELECT q.*, p.title as page_title, p.slug as page_slug
       FROM quizzes q JOIN pages p ON p.id = q.page_id
       ORDER BY q.id`,
    ).all() as Quiz[];
  }

  getRandomQuizzes(count: number): Quiz[] {
    return this.db.prepare(
      `SELECT q.*, p.title as page_title, p.slug as page_slug
       FROM quizzes q JOIN pages p ON p.id = q.page_id
       ORDER BY RANDOM() LIMIT ?`,
    ).all(count) as Quiz[];
  }

  deleteQuizzesByPage(pageId: number): void {
    this.mutations.run(() => {
      this.db.prepare("DELETE FROM quizzes WHERE page_id = ?").run(pageId);
    });
  }

  deleteQuizzesBySource(sourceId: number): void {
    this.mutations.run(() => {
      this.db.prepare(
        "DELETE FROM quiz_attempts WHERE quiz_id IN (SELECT id FROM quizzes WHERE page_id IN (SELECT id FROM pages WHERE source_id = ?))",
      ).run(sourceId);
      this.db.prepare(
        "DELETE FROM quizzes WHERE page_id IN (SELECT id FROM pages WHERE source_id = ?)",
      ).run(sourceId);
    });
  }

  deleteAllQuizzes(): void {
    this.mutations.run(() => {
      this.db.exec("DELETE FROM quiz_attempts");
      this.db.exec("DELETE FROM quizzes");
    });
  }

  getSmartQuizzes(count: number): Quiz[] {
    const now = new Date().toISOString();
    return this.db.prepare(
      `SELECT q.*, p.title as page_title, p.slug as page_slug
       FROM quizzes q
       JOIN pages p ON p.id = q.page_id
       WHERE q.next_review_at IS NULL OR q.next_review_at <= ?
       ORDER BY
         CASE WHEN q.next_review_at IS NULL THEN 0 ELSE 1 END,
         q.next_review_at ASC
       LIMIT ?`,
    ).all(now, count) as Quiz[];
  }

  updateQuizSRS(quizId: number, quality: number): void {
    this.mutations.run(() => {
      const quiz = this.db.prepare(
        "SELECT ease_factor, interval FROM quizzes WHERE id = ?",
      ).get(quizId) as QuizScheduleRow | undefined;
      if (!quiz) return;

      let easeFactor = quiz.ease_factor;
      let interval = quiz.interval;
      if (quality >= 3) {
        if (interval === 0) interval = 1;
        else if (interval === 1) interval = 6;
        else interval = Math.round(interval * easeFactor);

        easeFactor += 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
      } else {
        interval = 0;
      }
      if (easeFactor < 1.3) easeFactor = 1.3;

      const nextReview = new Date();
      nextReview.setDate(nextReview.getDate() + interval);
      this.db.prepare(
        "UPDATE quizzes SET ease_factor = ?, interval = ?, next_review_at = ? WHERE id = ?",
      ).run(easeFactor, interval, nextReview.toISOString(), quizId);
    });
  }

  getLearningStats(): LearningStats {
    const total = this.count("SELECT COUNT(*) as count FROM quizzes");
    const mastered = this.count(
      "SELECT COUNT(*) as count FROM quizzes WHERE interval >= 21",
    );
    const newQuizzes = this.count(
      "SELECT COUNT(*) as count FROM quizzes WHERE next_review_at IS NULL",
    );
    const dueToday = (this.db.prepare(
      "SELECT COUNT(*) as count FROM quizzes WHERE next_review_at <= ?",
    ).get(new Date().toISOString()) as CountRow).count;
    return {
      total,
      mastered,
      learning: total - mastered - newQuizzes,
      new: newQuizzes,
      dueToday,
    };
  }

  getWeakConcepts(limit: number): WeakConcept[] {
    return this.db.prepare(
      `SELECT p.title, p.slug, COUNT(qa.id) as wrongCount
       FROM quiz_attempts qa
       JOIN quizzes q ON q.id = qa.quiz_id
       JOIN pages p ON p.id = q.page_id
       WHERE qa.is_correct = 0
       GROUP BY p.id
       ORDER BY wrongCount DESC
       LIMIT ?`,
    ).all(limit) as WeakConcept[];
  }

  addQuizAttempt(quizId: number, isCorrect: boolean): void {
    this.mutations.run(() => {
      this.db.prepare(
        "INSERT INTO quiz_attempts (quiz_id, is_correct) VALUES (?, ?)",
      ).run(quizId, isCorrect ? 1 : 0);
      const quiz = this.db.prepare(
        "SELECT question FROM quizzes WHERE id = ?",
      ).get(quizId) as QuizQuestionRow | undefined;
      if (quiz) {
        this.activities.addActivityLog(
          "quiz_attempted",
          `Answered quiz: ${quiz.question.slice(0, 80)}`,
          "quiz",
          quizId,
          { is_correct: isCorrect },
        );
      }
    });
  }

  getQuizStats(): QuizStats {
    const totalQuizzes = this.count("SELECT COUNT(*) as count FROM quizzes");
    const attemptRow = this.db.prepare(
      `SELECT COUNT(*) as total,
         COALESCE(SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END), 0) as correct,
         COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) as incorrect
       FROM quiz_attempts`,
    ).get() as AttemptSummaryRow;
    const attemptedQuizzes = this.count(
      "SELECT COUNT(DISTINCT quiz_id) as count FROM quiz_attempts",
    );
    return {
      total: attemptRow.total,
      correct: attemptRow.correct,
      incorrect: attemptRow.incorrect,
      unattempted: totalQuizzes - attemptedQuizzes,
    };
  }

  getWeakQuizzes(limit: number): Quiz[] {
    return this.db.prepare(
      `SELECT q.*, p.title as page_title, p.slug as page_slug
       FROM quizzes q
       JOIN pages p ON p.id = q.page_id
       LEFT JOIN (
         SELECT quiz_id,
           SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) as wrong_count,
           COUNT(*) as attempt_count
         FROM quiz_attempts
         GROUP BY quiz_id
       ) a ON a.quiz_id = q.id
       ORDER BY
         CASE WHEN a.attempt_count IS NULL THEN 1 ELSE 0 END DESC,
         COALESCE(a.wrong_count, 0) DESC
       LIMIT ?`,
    ).all(limit) as Quiz[];
  }

  getQuizHistory(limit: number): QuizHistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT qa.quiz_id, q.question, qa.is_correct, qa.attempted_at
       FROM quiz_attempts qa
       JOIN quizzes q ON q.id = qa.quiz_id
       ORDER BY qa.attempted_at DESC
       LIMIT ?`,
    ).all(limit) as QuizHistoryRow[];
    return rows.map((row) => ({
      quiz_id: row.quiz_id,
      question: row.question,
      is_correct: row.is_correct === 1,
      attempted_at: row.attempted_at,
    }));
  }

  private count(sql: string): number {
    return (this.db.prepare(sql).get() as CountRow).count;
  }
}
