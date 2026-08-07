/**
 * A recording fake `fetch` for the vast.ai client tests.
 *
 * NO TEST IN THIS SUITE EVER TOUCHES THE NETWORK. Every response comes from a
 * fixture under tests/fixtures/vast/ (captured from vast.ai's published API
 * examples and its reference CLI), so the suite is safe to run on a machine
 * with a real API key present and can never rent, start, stop, or destroy
 * anything.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "vast");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), "utf8")) as T;
}

export interface RecordedCall {
  method: string;
  url: string;
  /** Path + query only, for terser assertions. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeRoute {
  method: string;
  /** Matched against the path with `startsWith` unless it is a RegExp. */
  path: string | RegExp;
  status?: number;
  /** Object -> JSON body. Function -> called with the recorded call. */
  response: unknown | ((call: RecordedCall) => unknown);
}

export interface FakeFetch {
  (input: string, init?: RequestInit): Promise<Response>;
  calls: RecordedCall[];
  /** Calls filtered to one method + path fragment. */
  callsTo(method: string, fragment: string): RecordedCall[];
}

/**
 * Build a fake fetch from a route table. An unmatched request throws, so a
 * test that accidentally reaches for an unmocked endpoint fails loudly rather
 * than silently hitting the real internet.
 */
export function makeFakeFetch(routes: FakeRoute[]): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    const { pathname, search } = new URL(url);
    const requestPath = `${pathname}${search}`;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      headers[key.toLowerCase()] = value;
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    const call: RecordedCall = { method, url, path: requestPath, headers, body: parsedBody };
    calls.push(call);

    const route = routes.find(
      (candidate) =>
        candidate.method.toUpperCase() === method &&
        (candidate.path instanceof RegExp
          ? candidate.path.test(requestPath)
          : requestPath.startsWith(candidate.path)),
    );
    if (!route) throw new Error(`fake fetch: no route for ${method} ${requestPath}`);
    const payload = typeof route.response === "function"
      ? (route.response as (c: RecordedCall) => unknown)(call)
      : route.response;
    const status = route.status ?? 200;
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const fake = impl as FakeFetch;
  fake.calls = calls;
  fake.callsTo = (method, fragment) =>
    calls.filter((call) => call.method === method.toUpperCase() && call.path.includes(fragment));
  return fake;
}

/** Route table covering the read-only endpoints, for tests that just need a client. */
export const readOnlyRoutes = (): FakeRoute[] => [
  { method: "POST", path: "/api/v0/bundles/", response: fixture("offers-search") },
  { method: "GET", path: "/api/v1/instances/", response: fixture("instances-list") },
  { method: "GET", path: "/api/v0/instances/20250806/", response: fixture("instance-running") },
  { method: "GET", path: "/api/v0/instances/20250808/", response: fixture("instance-loading") },
];
