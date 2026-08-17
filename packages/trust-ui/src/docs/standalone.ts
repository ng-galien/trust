/* The documentation can be built as a self-contained site (one HTML file, `npm run build:docs` in apps/trust-web).
   In that build there is no runtime and no interface behind the links: the pages hide what would lead nowhere. */
export const standalone = import.meta.env.VITE_TRUST_DOCS_STANDALONE === "1";
