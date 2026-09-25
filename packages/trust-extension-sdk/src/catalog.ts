/** Current editorial presentation of one published catalog version. */
export interface CatalogMetadata {
  readonly kind: "operation" | "procedure";
  readonly name: string;
  readonly version: string;
  /** Zero means the presentation still comes from its original Feature source. */
  readonly revision: number;
  readonly title: string;
  readonly description?: string;
  readonly classification: Readonly<Record<string, readonly string[]>>;
  readonly updatedAt?: string;
}

export interface CatalogMetadataUpdate extends Omit<CatalogMetadata, "revision" | "updatedAt"> {
  readonly expectedRevision: number;
}
