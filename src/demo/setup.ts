import { DEMO_SOURCES, DEMO_PAGES, DEMO_LINKS, DEMO_QUIZZES } from "./sample-data";
import type { Store } from "../store";

export async function setupDemo(store: Store): Promise<void> {
  // 1. Insert demo source
  for (const source of DEMO_SOURCES) {
    store.addSource(source.uri, source.type, source.title, source.raw_content);
  }

  // 2. Insert demo pages
  for (const page of DEMO_PAGES) {
    store.addPage(page.slug, page.title, page.content, page.source_id, undefined, page.page_type);
  }

  // 3. Insert demo links
  for (const link of DEMO_LINKS) {
    const fromPage = store.getPage(link.from);
    const toPage = store.getPage(link.to);
    if (fromPage && toPage) {
      store.addLink(fromPage.id, toPage.id, toPage.title);
    }
  }

  // 4. Insert demo quizzes
  for (const quiz of DEMO_QUIZZES) {
    const page = store.getPage(quiz.page_slug);
    if (page) {
      store.addQuiz(page.id, quiz.question, quiz.answer, quiz.quiz_type, (quiz as any).explanation || "");
    }
  }
}
