import type { Store } from "../store";
import type { LLMConfig } from "../config";

export interface IndexPage {
  id: number;
  title: string;
  slug: string;
  type: "source" | "concept";
  linkCount: number;
}

export interface IndexCategory {
  name: string;
  slug: string;
  description?: string;
  pages: IndexPage[];
}

export interface ContentIndex {
  categories: IndexCategory[];
  totalPages: number;
  totalLinks: number;
  generatedAt: string;
}

interface IndexConfig {
  useLLM?: boolean;
  llmConfig?: LLMConfig;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s가-힣-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

/**
 * Simple grouping: group pages by their source document, then orphan concepts separately.
 */
function groupBySource(store: Store): IndexCategory[] {
  const grouped = store.getPagesBySource();
  const categories: IndexCategory[] = [];

  for (const group of grouped) {
    categories.push({
      name: group.sourceTitle,
      slug: slugify(group.sourceTitle),
      description: `${group.sourceTitle} 소스 문서에서 생성된 페이지`,
      pages: group.pages.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        type: p.page_type as "source" | "concept",
        linkCount: p.linkCount,
      })),
    });
  }

  // Sort categories alphabetically
  categories.sort((a, b) => a.name.localeCompare(b.name));

  // Sort pages within each category by link count (descending)
  for (const cat of categories) {
    cat.pages.sort((a, b) => b.linkCount - a.linkCount);
  }

  return categories;
}

/**
 * Smart grouping: use LLM to categorize pages into topic clusters.
 */
async function groupByLLM(store: Store, llmConfig: LLMConfig): Promise<IndexCategory[]> {
  const { LLMClient } = await import("../llm-client");
  const client = new LLMClient(llmConfig);

  const pages = store.listPages();
  const links = store.getAllLinks();

  // Build link count map
  const linkCountMap = new Map<number, number>();
  for (const link of links) {
    linkCountMap.set(link.to_page_id, (linkCountMap.get(link.to_page_id) || 0) + 1);
    linkCountMap.set(link.from_page_id, (linkCountMap.get(link.from_page_id) || 0) + 1);
  }

  const pageTitles = pages.map((p) => `- ${p.title} (${p.page_type})`).join("\n");

  const system = `You are a knowledge organizer. Given a list of wiki page titles, categorize them into 5-10 meaningful topic clusters. Return ONLY a JSON array of objects with: name (category name), description (short description), pages (array of page titles belonging to this category). Every page must be assigned to exactly one category.`;

  const userMessage = `Categorize these wiki pages into topic clusters:\n\n${pageTitles}\n\nReturn JSON array only, no markdown fences.`;

  try {
    const response = await client.chatComplete(system, userMessage, 4096);

    // Parse the JSON response
    const cleaned = response.replace(/```json?\s*|```\s*/g, "").trim();
    const clusters = JSON.parse(cleaned) as Array<{
      name: string;
      description?: string;
      pages: string[];
    }>;

    // Build page lookup by title
    const pageByTitle = new Map(pages.map((p) => [p.title, p]));

    const categories: IndexCategory[] = clusters.map((cluster) => ({
      name: cluster.name,
      slug: slugify(cluster.name),
      description: cluster.description,
      pages: cluster.pages
        .map((title) => {
          const page = pageByTitle.get(title);
          if (!page) return null;
          return {
            id: page.id,
            title: page.title,
            slug: page.slug,
            type: page.page_type as "source" | "concept",
            linkCount: linkCountMap.get(page.id) || 0,
          };
        })
        .filter((p): p is IndexPage => p !== null),
    }));

    // Add any uncategorized pages
    const categorizedTitles = new Set(clusters.flatMap((c) => c.pages));
    const uncategorized = pages.filter((p) => !categorizedTitles.has(p.title));
    if (uncategorized.length > 0) {
      categories.push({
        name: "기타",
        slug: "etc",
        description: "분류되지 않은 페이지",
        pages: uncategorized.map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug,
          type: p.page_type as "source" | "concept",
          linkCount: linkCountMap.get(p.id) || 0,
        })),
      });
    }

    // Sort
    categories.sort((a, b) => a.name.localeCompare(b.name));
    for (const cat of categories) {
      cat.pages.sort((a, b) => b.linkCount - a.linkCount);
    }

    return categories;
  } catch {
    // Fallback to simple grouping if LLM fails
    console.warn("LLM categorization failed, falling back to source-based grouping");
    return groupBySource(store);
  }
}

/**
 * Generate a structured content index for all wiki pages.
 */
export async function generateContentIndex(
  store: Store,
  config?: IndexConfig
): Promise<ContentIndex> {
  const totalPages = store.countPages();
  const totalLinks = store.getAllLinks().length;

  let categories: IndexCategory[];

  if (config?.useLLM && config.llmConfig?.api_key) {
    categories = await groupByLLM(store, config.llmConfig);
  } else {
    categories = groupBySource(store);
  }

  return {
    categories,
    totalPages,
    totalLinks,
    generatedAt: new Date().toISOString(),
  };
}
