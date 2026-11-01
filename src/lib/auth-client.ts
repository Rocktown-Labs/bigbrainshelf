import { createAuthClient } from "better-auth/client";
import { usernameClient } from "better-auth/client/plugins";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;

export function normalizeUsername(raw: string): string {
  return String(raw || "").trim().replace(/^@+/, "").toLowerCase();
}

export function validateUsernameFormat(raw: string): {
  valid: boolean;
  normalized: string;
  displayUsername: string;
  error?: string;
} {
  const displayUsername = String(raw || "").trim().replace(/^@+/, "");
  const normalized = displayUsername.toLowerCase();
  if (!displayUsername) {
    return { valid: false, normalized: "", displayUsername: "", error: "Enter a username." };
  }
  if (displayUsername.length < USERNAME_MIN_LENGTH) {
    return {
      valid: false,
      normalized,
      displayUsername,
      error: `Username must be at least ${USERNAME_MIN_LENGTH} characters.`,
    };
  }
  if (displayUsername.length > USERNAME_MAX_LENGTH) {
    return {
      valid: false,
      normalized,
      displayUsername,
      error: `Username must be at most ${USERNAME_MAX_LENGTH} characters.`,
    };
  }
  if (!USERNAME_REGEX.test(displayUsername)) {
    return {
      valid: false,
      normalized,
      displayUsername,
      error: "Use only letters, numbers, underscores (_), or dots (.).",
    };
  }
  return { valid: true, normalized, displayUsername };
}

export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
