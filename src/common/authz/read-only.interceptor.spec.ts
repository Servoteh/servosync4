import { ForbiddenException } from "@nestjs/common";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import {
  isReadOnlyUserId,
  ReadOnlyInterceptor,
} from "./read-only.interceptor";

const ctxFor = (req: object): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe("ReadOnlyInterceptor", () => {
  const interceptor = new ReadOnlyInterceptor();
  let next: CallHandler;
  const prevEnv = process.env.AUTHZ_READONLY_USER_IDS;

  beforeEach(() => {
    process.env.AUTHZ_READONLY_USER_IDS = "49, 120";
    next = { handle: jest.fn() } as unknown as CallHandler;
  });

  afterAll(() => {
    process.env.AUTHZ_READONLY_USER_IDS = prevEnv;
  });

  it("blocks mutations for a configured read-only user", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() =>
        interceptor.intercept(
          ctxFor({ method, url: "/api/work-orders/1", user: { userId: 49 } }),
          next,
        ),
      ).toThrow(ForbiddenException);
    }
    expect(next.handle).not.toHaveBeenCalled();
  });

  it("allows GET for a read-only user", () => {
    interceptor.intercept(
      ctxFor({ method: "GET", url: "/api/work-orders", user: { userId: 49 } }),
      next,
    );
    expect(next.handle).toHaveBeenCalled();
  });

  it("allows mutations for other users", () => {
    interceptor.intercept(
      ctxFor({ method: "POST", url: "/api/work-orders", user: { userId: 2 } }),
      next,
    );
    expect(next.handle).toHaveBeenCalled();
  });

  it("passes public routes (no req.user, e.g. /auth/login, /auth/sso)", () => {
    interceptor.intercept(
      ctxFor({ method: "POST", url: "/api/auth/login" }),
      next,
    );
    expect(next.handle).toHaveBeenCalled();
  });

  it("allows read-POSTs (barcode decode) for a read-only user", () => {
    interceptor.intercept(
      ctxFor({
        method: "POST",
        url: "/api/tech-processes/barcode/decode?x=1",
        user: { userId: 49 },
      }),
      next,
    );
    expect(next.handle).toHaveBeenCalled();
  });

  it("is inert when env is unset", () => {
    delete process.env.AUTHZ_READONLY_USER_IDS;
    interceptor.intercept(
      ctxFor({ method: "DELETE", url: "/api/x/1", user: { userId: 49 } }),
      next,
    );
    expect(next.handle).toHaveBeenCalled();
  });
});

describe("isReadOnlyUserId", () => {
  const prevEnv = process.env.AUTHZ_READONLY_USER_IDS;
  afterAll(() => {
    process.env.AUTHZ_READONLY_USER_IDS = prevEnv;
  });

  it("parses CSV with whitespace and junk", () => {
    process.env.AUTHZ_READONLY_USER_IDS = " 49 ,x, ,120";
    expect(isReadOnlyUserId(49)).toBe(true);
    expect(isReadOnlyUserId(120)).toBe(true);
    expect(isReadOnlyUserId(2)).toBe(false);
    expect(isReadOnlyUserId(null)).toBe(false);
    expect(isReadOnlyUserId(undefined)).toBe(false);
  });
});
