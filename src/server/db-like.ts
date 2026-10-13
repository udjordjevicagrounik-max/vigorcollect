/**
 * The ONLY place a LIKE / ILIKE pattern is built from user input (5.1, semgrep
 * no-unescaped-like): \ % _ are escaped, so "50%" or "a_b" match literally and a lone "%" cannot
 * turn a search into "everything". Postgres' default LIKE escape character is the backslash.
 */
export function likeContains(input: string): string {
  return `%${input.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function likePrefix(input: string): string {
  return `${input.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
