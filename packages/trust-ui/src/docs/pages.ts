import type { ComponentType } from "react";

import type { Language } from "../i18n/index.js";

/* Documentation pages — one MDX file per page under `content/<language>/…`.
   The path below the language is the URL below `/docs`; `index.mdx` is the folder page.
   The tree, titles and search text come from the files themselves (front matter + `searchText`):
   adding a page is adding a file. English is the reference; a missing translation falls back to it. */

interface PageModule {
  frontmatter: { title: string; summary?: string; order?: number; draft?: boolean; screen?: string };
  searchText: string;
  default: ComponentType;
}

export interface DocsPage {
  /** URL path below `/docs` ("" for the root, "operations/steps/shell" …). */
  path: string;
  language: Language;
  title: string;
  summary: string;
  order: number;
  /** Written but not yet complete — shown with a draft mark. */
  draft: boolean;
  /** Screen this page documents (`/operations`, …): the screen guide links back to it. */
  screen: string | undefined;
  searchText: string;
  Content: ComponentType;
}

export interface DocsNode {
  page: DocsPage;
  children: DocsNode[];
}

const modules = import.meta.glob<PageModule>("./content/*/**/*.mdx", { eager: true });

const pages: DocsPage[] = Object.entries(modules).map(([file, module]) => {
  const match = /^\.\/content\/([a-z]{2})\/(.*)\.mdx$/.exec(file);
  const [, language, rest] = match ?? [];
  const path = (rest ?? "").replace(/(^|\/)index$/, "");
  return {
    path,
    language: language as Language,
    title: module.frontmatter.title,
    summary: module.frontmatter.summary ?? "",
    order: module.frontmatter.order ?? 999,
    draft: module.frontmatter.draft ?? false,
    screen: module.frontmatter.screen,
    searchText: module.searchText,
    Content: module.default,
  };
});

/** The page at `path` in `language`, or its English fallback. */
export function findPage(path: string, language: Language): { page: DocsPage; fallback: boolean } | undefined {
  const own = pages.find((page) => page.path === path && page.language === language);
  if (own) return { page: own, fallback: false };
  const english = pages.find((page) => page.path === path && page.language === "en");
  return english ? { page: english, fallback: true } : undefined;
}

/** Every page (its translation when it exists), as a tree ordered by `order` then title. */
export function pageTree(language: Language): DocsNode[] {
  const byPath = new Map<string, DocsPage>();
  for (const page of pages) {
    if (page.language === "en" || page.language === language) {
      const current = byPath.get(page.path);
      if (!current || page.language === language) byPath.set(page.path, page);
    }
  }
  const nodes = new Map<string, DocsNode>();
  for (const page of byPath.values()) nodes.set(page.path, { page, children: [] });
  const roots: DocsNode[] = [];
  for (const node of nodes.values()) {
    if (node.page.path === "") continue;
    const parentPath = node.page.path.includes("/") ? node.page.path.slice(0, node.page.path.lastIndexOf("/")) : "";
    const parent = nodes.get(parentPath) ?? nodes.get("");
    (parent && parent !== node ? parent.children : roots).push(node);
  }
  const sort = (list: DocsNode[]) => {
    list.sort((a, b) => a.page.order - b.page.order || a.page.title.localeCompare(b.page.title));
    for (const node of list) sort(node.children);
  };
  const root = nodes.get("");
  const top = root ? root.children : roots;
  sort(top);
  return top;
}

/** Flat reading order (depth-first), used for previous/next links and search. */
export function pageSequence(language: Language): DocsPage[] {
  const out: DocsPage[] = [];
  const root = findPage("", language);
  if (root) out.push(root.page);
  const walk = (list: DocsNode[]) => {
    for (const node of list) {
      out.push(node.page);
      walk(node.children);
    }
  };
  walk(pageTree(language));
  return out;
}

/** The node of `path` in the tree (its children feed the hub cards). */
export function findNode(path: string, language: Language): DocsNode | undefined {
  const search = (list: DocsNode[]): DocsNode | undefined => {
    for (const node of list) {
      if (node.page.path === path) return node;
      const found = search(node.children);
      if (found) return found;
    }
    return undefined;
  };
  if (path === "") {
    const root = findPage("", language);
    return root ? { page: root.page, children: pageTree(language) } : undefined;
  }
  return search(pageTree(language));
}

/** Pages whose title, summary or text contains the query (case-insensitive), best first. */
export function searchPages(query: string, language: Language, limit = 8): Array<{ page: DocsPage; excerpt: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: Array<{ page: DocsPage; score: number; excerpt: string }> = [];
  for (const page of pageSequence(language)) {
    const title = page.title.toLowerCase();
    const summary = page.summary.toLowerCase();
    const text = page.searchText.toLowerCase();
    let score = 0;
    if (title.includes(needle)) score += 10;
    if (summary.includes(needle)) score += 4;
    const at = text.indexOf(needle);
    if (at >= 0) score += 1;
    if (!score) continue;
    const excerpt = at >= 0 ? excerptAround(page.searchText, at, needle.length) : page.summary;
    scored.push({ page, score, excerpt });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ page, excerpt }) => ({ page, excerpt }));
}

function excerptAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + length + 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}
