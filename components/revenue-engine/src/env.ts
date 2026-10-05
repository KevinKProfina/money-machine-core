/** Loads ./.env if present (Node >= 21 built-in); a missing file is fine. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // no .env file — rely on the real environment
  }
}
