// The only module that touches the asana SDK.

import { ApiClient, UsersApi, WorkspacesApi } from "asana";

export const ASANA_API = "https://app.asana.com/api/1.0";

/** An Asana gid: a decimal string, kept as a string since gids outgrow a double. */
export const GID = /^\d{1,20}$/;

/** Carries no reference to the SDK's error, whose request object holds the token. */
export class AsanaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type User = { gid: string; name: string; email?: string };
export type Workspace = { gid: string; name: string };

type SdkError = {
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  response?: { body?: { errors?: unknown }; headers?: Record<string, unknown> };
};

/** One line, so text from Asana cannot forge lines in a reply or the log. */
function oneLine(text: string, max = 500): string {
  return [...text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")].slice(0, max).join("");
}

function describeFailure(err: unknown): { message: string; status?: number } {
  const sdkError = (err ?? {}) as SdkError;
  // A body that fails to parse carries only statusCode.
  const status = [sdkError.status, sdkError.statusCode].find((value) => typeof value === "number") as number | undefined;
  if (status === undefined) return { message: `cannot reach Asana: ${oneLine(String(sdkError.message ?? err))}` };
  const errors = sdkError.response?.body?.errors;
  const reasons = (Array.isArray(errors) ? errors : [])
    .map((error) => error?.message)
    .filter((message): message is string => typeof message === "string");
  const reason = reasons.length ? reasons.join("; ") : String(sdkError.message ?? "no reason given");
  let message = `Asana answered ${status}: ${oneLine(reason)}`;
  if (status === 429) {
    const retryAfter = String(sdkError.response?.headers?.["retry-after"] ?? "");
    message += /^\d{1,6}$/.test(retryAfter) ? `. Retry after ${retryAfter} seconds.` : ". Retry later.";
  }
  return { message, status };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? oneLine(value) : undefined;
}

export class Asana {
  private readonly users: UsersApi;
  private readonly workspaces: WorkspacesApi;

  constructor(token: string, basePath = ASANA_API) {
    const client = new ApiClient();
    client.basePath = basePath;
    client.authentications.token.accessToken = token;
    // superagent resends the Authorization header on a 307 or 308 to any host.
    const applyAuth = client.applyAuthToRequest.bind(client);
    client.applyAuthToRequest = (request, authNames) => applyAuth(request.redirects(0), authNames);
    this.users = new UsersApi(client);
    this.workspaces = new WorkspacesApi(client);
  }

  private async call(what: string, request: () => Promise<unknown>): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await request();
    } catch (err) {
      const { message, status } = describeFailure(err);
      throw new AsanaError(`${what}: ${message}`, status);
    }
    const data = (body as { data?: unknown } | null)?.data as Record<string, unknown> | undefined;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new AsanaError(`${what}: Asana's answer had no data`);
    }
    if (typeof data.gid !== "string" || !GID.test(data.gid)) throw new AsanaError(`${what}: Asana's answer had no gid`);
    return data;
  }

  async me(): Promise<User> {
    const data = await this.call("reading the token's user", () =>
      this.users.getUser("me", { opt_fields: "name,email" }),
    );
    return { gid: data.gid as string, name: text(data.name) ?? "", email: text(data.email) };
  }

  async workspace(gid: string): Promise<Workspace> {
    const data = await this.call(`reading workspace ${gid}`, () =>
      this.workspaces.getWorkspace(gid, { opt_fields: "name" }),
    );
    return { gid: data.gid as string, name: text(data.name) ?? "" };
  }
}

export async function openWorkspace(asana: Asana, workspaceGid: string): Promise<{ user: User; workspace: Workspace }> {
  const user = await asana.me();
  const workspace = await asana.workspace(workspaceGid);
  if (workspace.gid !== workspaceGid) {
    throw new AsanaError(`reading workspace ${workspaceGid}: Asana answered with workspace ${workspace.gid}`);
  }
  return { user, workspace };
}
