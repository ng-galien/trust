/** Shape of a translated dictionary: same keys as the English source, every leaf a string. */
export type Translation<T> = { readonly [K in keyof T]: T[K] extends string ? string : Translation<T[K]> };
