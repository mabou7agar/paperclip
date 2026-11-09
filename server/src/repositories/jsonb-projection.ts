import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Expand a toasted JSON value once, then project only the fields a reader needs.
 * The empty path preserves objects, arrays, scalars, JSON null and SQL NULL.
 * OFFSET 0 is an optimizer barrier: flattening this subquery would repeat the
 * decompression for every field. Nothing is persisted or cached between reads.
 */
export function projectJsonb<T>(source: SQLWrapper, project: (value: SQL) => SQL<T>): SQL<T> {
  const value = sql`"expanded_json"."value"`;
  return sql<T>`(select ${project(value)} from (
    select ${source} #> '{}'::text[] as "value" offset 0
  ) as "expanded_json")`;
}
