declare module "*.mdx" {
  import type { ComponentType } from "react";

  /** Page metadata from the YAML front matter (`remark-mdx-frontmatter`). */
  export const frontmatter: { title: string; summary?: string; order?: number; draft?: boolean; screen?: string };
  /** Plain text of the page, exported by the `remarkSearchText` plugin of the app pipeline. */
  export const searchText: string;
  const MDXContent: ComponentType<{ components?: Record<string, ComponentType<never>> }>;
  export default MDXContent;
}
