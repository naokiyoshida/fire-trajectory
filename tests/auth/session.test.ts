import { describe, expect, it } from "vitest";
import { isLoginUrl, SESSION_INDICATOR_SELECTORS } from "../../app/auth/session.js";

describe("auth/session", () => {
  it("isLoginUrl matches /sign_in URLs", () => {
    expect(isLoginUrl("https://moneyforward.com/sign_in")).toBe(true);
    expect(isLoginUrl("https://moneyforward.com/sign_in?foo=bar")).toBe(true);
    expect(isLoginUrl("https://id.moneyforward.com/sign_in/email")).toBe(true);
  });

  it("isLoginUrl rejects non-login URLs", () => {
    expect(isLoginUrl("https://moneyforward.com/cf")).toBe(false);
    expect(isLoginUrl("https://moneyforward.com/bs/portfolio")).toBe(false);
    expect(isLoginUrl("")).toBe(false);
  });

  it("exposes a non-empty list of session indicator selectors", () => {
    expect(SESSION_INDICATOR_SELECTORS.length).toBeGreaterThan(0);
    for (const sel of SESSION_INDICATOR_SELECTORS) {
      expect(typeof sel).toBe("string");
      expect(sel.length).toBeGreaterThan(0);
    }
  });
});
