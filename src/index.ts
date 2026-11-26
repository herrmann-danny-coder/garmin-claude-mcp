import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

const BASE = "https://intervals.icu/api/v1";

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Intervals.icu", version: "1.0.0" });

  private authHeader() {
    return `Basic ${btoa(`API_KEY:${this.env.INTERVALS_API_KEY}`)}`;
  }

  private async icu(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`intervals.icu ${res.status}: ${await res.text()}`);
    const text = await res.text();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  }

  async init() {
    const athlete = this.env.INTERVALS_ATHLETE_ID;

    this.server.tool(
      "getRecentActivities",
      { days: z.number().optional().describe("Days back, default 14") },
      async ({ days = 14 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/activities?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getWellness",
      { days: z.number().optional().describe("Days back, default 7") },
      async ({ days = 7 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/wellness?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "listUpcomingEvents",
      { days: z.number().optional().describe("Days ahead, default 14") },
      async ({ days = 14 }) => {
        const today = new Date().toISOString().slice(0, 10);
        const newest = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/events?oldest=${today}&newest=${newest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "createWorkout",
      {
        date: z.string().describe("YYYY-MM-DD"),
        name: z.string(),
        type: z.string().describe("Run, Ride, Swim, etc."),
        description: z.string().describe("Structured steps, e.g. '- 10m Z2\\n- 6x800m Z4, 400m Z1 jog\\n- 10m Z2'"),
      },
      async ({ date, name, type, description }) => {
        const data = await this.icu(`/athlete/${athlete}/events`, {
          method: "POST",
          body: JSON.stringify({ start_date_local: `${date}T00:00:00`, category: "WORKOUT", type, name, description }),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "updateWorkout",
      {
        eventId: z.number().describe("Event ID from listUpcomingEvents"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ eventId, date, name, type, description }) => {
        const body: Record<string, unknown> = {};
        if (date) body.start_date_local = `${date}T00:00:00`;
        if (name) body.name = name;
        if (type) body.type = type;
        if (description) body.description = description;
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getActivityIntervals",
      { activityId: z.string().describe("Activity id from getRecentActivities, e.g. i214377864") },
      async ({ activityId }) => {
        const id = encodeURIComponent(activityId);
        let raw: any;
        try {
          raw = await this.icu(`/activity/${id}/intervals`);
        } catch {
          raw = await this.icu(`/activity/${id}?intervals=true`);
        }
        const list: any[] = Array.isArray(raw) ? raw : raw?.icu_intervals ?? [];
        const intervals = list.map((iv: any) => ({
          type: iv.type ?? null,
          label: iv.label ?? null,
          start_time: iv.start_time ?? null,
          moving_time: iv.moving_time ?? iv.elapsed_time ?? null,
          distance: iv.distance ?? null,
          average_speed: iv.average_speed ?? (iv.distance && iv.moving_time ? iv.distance / iv.moving_time : null),
          gap: iv.gap ?? iv.average_gap ?? null,
          average_heartrate: iv.average_heartrate ?? null,
          max_heartrate: iv.max_heartrate ?? null,
          average_cadence: iv.average_cadence ?? null,
          group_id: iv.group_id ?? null,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ activityId, intervals }) }] };
      },
    );

    this.server.tool(
      "getRunSettings",
      {},
      async () => {
        const list: any[] = await this.icu(`/athlete/${athlete}/sport-settings`);
        const run = (list || []).find((x: any) => (x.types || []).includes("Run"));
        const out = run ? { id: run.id, types: run.types, lthr: run.lthr ?? null, max_hr: run.max_hr ?? null, hr_zones: run.hr_zones ?? null, hr_zone_names: run.hr_zone_names ?? null, threshold_pace: run.threshold_pace ?? null } : null;
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      },
    );

    this.server.tool(
      "updateRunZones",
      {
        lthr: z.number().int().min(120).max(210).describe("New lactate threshold heart rate (bpm)"),
        max_hr: z.number().int().min(140).max(230).optional().describe("New max heart rate (bpm); omit to keep"),
      },
      async ({ lthr, max_hr }) => {
        const list: any[] = await this.icu(`/athlete/${athlete}/sport-settings`);
        const run = (list || []).find((x: any) => (x.types || []).includes("Run"));
        if (!run) throw new Error("No Run sport settings found");
        const oldL = run.lthr;
        const newMax = max_hr ?? run.max_hr;
        let zones = run.hr_zones;
        if (Array.isArray(zones) && zones.length > 1 && oldL) {
          // keep the athlete's zone model: scale every boundary by newLTHR/oldLTHR, last boundary = max HR
          zones = zones.map((b: number, i: number) => (i === zones.length - 1 && newMax ? newMax : Math.round((b * lthr) / oldL)));
        }
        const body: any = { lthr, hr_zones: zones };
        if (newMax) body.max_hr = newMax;
        const data = await this.icu(`/athlete/${athlete}/sport-settings/${run.id}`, { method: "PUT", body: JSON.stringify(body) });
        return { content: [{ type: "text", text: JSON.stringify({ before: { lthr: oldL, max_hr: run.max_hr, hr_zones: run.hr_zones }, after: { lthr: data?.lthr, max_hr: data?.max_hr, hr_zones: data?.hr_zones } }) }] };
      },
    );

    this.server.tool(
      "deleteEvent",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, { method: "DELETE" });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  }
}

function loginPage(state: string, error: string) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intervals.icu MCP</title>
  <body style="font-family:system-ui;max-width:20rem;margin:4rem auto">
  <h2>Intervals.icu MCP</h2>
  <p style="color:#c00">${error}</p>
  <form method="post">
    <input type="hidden" name="state" value="${state}">
    <input type="password" name="password" placeholder="Password" autofocus
           style="width:100%;padding:.5rem;margin-bottom:.5rem">
    <button style="width:100%;padding:.5rem">Authorize</button>
  </form></body>`;
}

const defaultHandler = {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const html = { "content-type": "text/html;charset=utf-8" };

    if (request.method === "GET") {
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return new Response(loginPage(btoa(JSON.stringify(info)), ""), { headers: html });
    }

    const body = await request.formData();
    const state = String(body.get("state") ?? "");
    if (String(body.get("password")) !== env.MCP_PASSWORD) {
      return new Response(loginPage(state, "Wrong password"), { status: 401, headers: html });
    }

    const info = JSON.parse(atob(state));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: "owner",
      metadata: {},
      scope: info.scope ?? [],
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
