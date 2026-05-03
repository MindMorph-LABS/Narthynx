const TOKEN_KEY = "narthynx_cockpit_token";

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearStoredToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function cockpitFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getStoredToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
