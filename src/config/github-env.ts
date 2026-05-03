export function getGithubAuthToken(): string | undefined {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return typeof t === "string" && t.trim().length > 0 ? t.trim() : undefined;
}
