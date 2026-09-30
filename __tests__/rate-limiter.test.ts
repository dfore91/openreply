/**
 * Rate Limiter — Unit Tests
 *
 * Tests the hourly private-reply cap enforcement using mocked Redis.
 * Assertions derive from RATE_LIMIT_MAX so they survive a change to the cap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet, mockEval, mockDel, mockDecr } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockEval: vi.fn(),
  mockDel: vi.fn(),
  mockDecr: vi.fn(),
}));

vi.mock("ioredis", () => {
  const MockRedis = vi.fn().mockImplementation(function (
    this: Record<string, unknown>
  ) {
    this.get = mockGet;
    this.eval = mockEval;
    this.del = mockDel;
    this.decr = mockDecr;
    return this;
  });
  return { default: MockRedis };
});

vi.stubEnv("REDIS_URL", "redis://localhost:6379");

import {
  checkRateLimit,
  incrementDMCounter,
  reserveDMSlot,
  releaseDMSlot,
  RATE_LIMIT_MAX,
} from "../lib/utils/rate-limiter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkRateLimit", () => {
  it("should allow when count is below limit", async () => {
    mockGet.mockResolvedValue("50");

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(50);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - 50);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.reserved).toBe(false);
  });

  it("should allow when no previous count exists", async () => {
    mockGet.mockResolvedValue(null);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX);
  });

  it("should deny when count reaches the limit", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockGet.mockResolvedValue(String(RATE_LIMIT_MAX));

    const result = await checkRateLimit("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("reserveDMSlot", () => {
  it("should atomically reserve a slot when below the hourly cap", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const result = await reserveDMSlot("account_123");

    expect(mockEval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rate:dm:account_123",
      RATE_LIMIT_MAX,
      3600
    );
    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.currentCount).toBe(51);
    expect(result.remainingDMs).toBe(139);
  });

  it("should recommend requeue when the atomic reserve is denied", async () => {
    mockEval.mockResolvedValue([0, RATE_LIMIT_MAX, 0]);

    const result = await reserveDMSlot("account_123", 0);

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockEval.mockResolvedValue(["0", String(RATE_LIMIT_MAX), "0"]);

    const result = await reserveDMSlot("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("incrementDMCounter", () => {
  it("should use the atomic reservation path", async () => {
    mockEval.mockResolvedValue([1, 51, 139]);

    const count = await incrementDMCounter("account_123");

    expect(mockEval).toHaveBeenCalled();
    expect(count).toBe(51);
  });
});

describe("releaseDMSlot", () => {
  it("hands a reserved slot back and returns the new count", async () => {
    mockDecr.mockResolvedValue(49);

    const count = await releaseDMSlot("account_123");

    expect(mockDecr).toHaveBeenCalledWith("rate:dm:account_123");
    expect(count).toBe(49);
  });

  it("clamps to zero and clears the key when nothing was reserved", async () => {
    mockDecr.mockResolvedValue(-1);

    const count = await releaseDMSlot("account_123");

    expect(count).toBe(0);
    expect(mockDel).toHaveBeenCalledWith("rate:dm:account_123");
  });
});

describe("hourlyCapFor (warm-up)", () => {
  const IG = "17841401912988095";
  const day = (iso: string) => Date.parse(`${iso}T15:00:00Z`);
  const warm = JSON.stringify({ [IG]: { start: "2026-09-30", perHour: 10, dailyGrowth: 1.4 } });

  it("keeps Meta's cap for accounts without a warm-up", async () => {
    vi.stubEnv("DM_WARMUP", warm);
    const { hourlyCapFor } = await import("../lib/utils/rate-limiter");
    expect(hourlyCapFor("someone_else", day("2026-09-30"))).toBe(RATE_LIMIT_MAX);
  });

  it("starts low and rises every day", async () => {
    vi.stubEnv("DM_WARMUP", warm);
    const { hourlyCapFor } = await import("../lib/utils/rate-limiter");
    expect(hourlyCapFor(IG, day("2026-09-30"))).toBe(10);
    expect(hourlyCapFor(IG, day("2026-10-01"))).toBe(14);
    expect(hourlyCapFor(IG, day("2026-10-03"))).toBe(27);
    expect(hourlyCapFor(IG, day("2026-12-31"))).toBe(RATE_LIMIT_MAX);
  });

  it("falls back to Meta's cap on a malformed variable", async () => {
    vi.stubEnv("DM_WARMUP", "{not json");
    const { hourlyCapFor } = await import("../lib/utils/rate-limiter");
    expect(hourlyCapFor(IG, day("2026-09-30"))).toBe(RATE_LIMIT_MAX);
  });

  it("reserves against the warm-up cap", async () => {
    vi.stubEnv("DM_WARMUP", warm);
    mockEval.mockResolvedValue([0, 10, 0]);
    await reserveDMSlot(IG);
    expect(mockEval.mock.calls.at(-1)?.[3]).toBe(hourlyCapFor_now(IG));
  });
});

function hourlyCapFor_now(id: string): number {
  // Same formula as the limiter, evaluated at the moment of the call.
  const days = Math.max(0, Math.floor((Date.now() - Date.parse("2026-09-30T00:00:00Z")) / 86_400_000));
  return Math.min(RATE_LIMIT_MAX, Math.max(1, Math.floor(10 * Math.pow(1.4, days))));
}
