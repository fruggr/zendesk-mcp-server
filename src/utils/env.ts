/**
 * Reads `name` from the environment. `name` in the result is the variable the
 * value came from, so an error about it names what the operator actually set.
 * Every variable goes through here, so a future rename has a single place to
 * map the old name (AGENTS.md, "Environment variables").
 */
export const readEnv = (name: string): { name: string; value: string | undefined } => ({
  name,
  value: process.env[name],
});
