import { ApiError, errorMessage, fieldErrors, isAiUnavailable, parseErrorResponse, toApiError } from "./apiError";

describe("apiError", () => {
  it("parses the API error model", () => {
    const e = parseErrorResponse(422, { error: { code: "CONTACT_OPTED_OUT", message: "This contact has opted out of SMS" } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(422);
    expect(e.code).toBe("CONTACT_OPTED_OUT");
    expect(e.message).toBe("This contact has opted out of SMS");
  });

  it("falls back to a generic message for non-JSON failures", () => {
    expect(parseErrorResponse(502, null).message).toBe("Request failed (502)");
    expect(parseErrorResponse(0, null).code).toBe("NETWORK_ERROR");
  });

  it("wraps unknown thrown values", () => {
    expect(toApiError(new Error("boom")).message).toBe("boom");
    expect(errorMessage("weird")).toBe("Something went wrong");
  });

  it("detects the AI_UNAVAILABLE code", () => {
    expect(isAiUnavailable(new ApiError(503, "AI_UNAVAILABLE", "AI is unavailable"))).toBe(true);
    expect(isAiUnavailable(new ApiError(500, "INTERNAL", "x"))).toBe(false);
  });

  it("maps validation details to field errors, keeping the first per field", () => {
    const e = new ApiError(400, "VALIDATION_ERROR", "Invalid", [
      { path: "email", message: "Invalid email" },
      { path: "email", message: "second" },
      { path: "password", message: "Too short" },
    ]);
    expect(fieldErrors(e)).toEqual({ email: "Invalid email", password: "Too short" });
    expect(fieldErrors(new Error("x"))).toEqual({});
  });
});
