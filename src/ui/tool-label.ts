/**
 * The one-line label of a tool step: what the AI does or did, with the
 * note or query it concerns ("Reading Plan…", "Edited Plan", "Editing
 * Plan failed"). Parameters and the result stay one click away.
 */

export type ToolState = "running" | "done" | "error";

/** Present ("Reading") while the tool runs or when it failed, past ("Read") once done. */
const VERBS: Record<string, [string, string]> = {
  read_document: ["Reading", "Read"],
  read_file: ["Reading", "Read"],
  edit_document: ["Editing", "Edited"],
  create_file: ["Creating", "Created"],
  open_document: ["Opening", "Opened"],
  get_properties: ["Reading the properties of", "Read the properties of"],
  set_properties: ["Updating the properties of", "Updated the properties of"],
  get_links: ["Finding links of", "Found links of"],
  get_backlinks: ["Finding links of", "Found links of"],
  search_vault: ["Searching for", "Searched for"],
  list_files: ["Listing", "Listed"],
  rename_file: ["Renaming", "Renamed"],
  delete_file: ["Moving to the trash:", "Moved to the trash:"],
  get_current_datetime: ["Checking", "Checked"],
  ask_user: ["Asking a question", "Asked a question"],
  query_notes: ["Finding notes", "Found notes"],
  list_metadata: ["Listing the tags and properties of", "Listed the tags and properties of"],
  read_canvas: ["Reading", "Read"],
  edit_canvas: ["Editing", "Edited"],
  read_web_page: ["Reading", "Read"],
  view_image: ["Looking at", "Looked at"],
  view_canvas: ["Looking at", "Looked at"],
  use_skill: ["Using the skill", "Used the skill"],
};

/** A file path as a reader names it: the file name, without `.md`. */
export function fileLabel(path: unknown): string {
  if (typeof path !== "string" || !path.trim()) return "the current note";
  const name = path.replace(/\/+$/, "").split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

/** query_notes' filters in words: "tagged #project, status active in Work". */
function noteFilter(input: Record<string, unknown>): string {
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const properties = input.properties && typeof input.properties === "object" ? Object.entries(input.properties) : [];
  const parts = [
    ...(tags.length ? [`tagged ${tags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(input.match === "any" ? " or " : " ")}`] : []),
    ...properties.map(([key, value]) => (value === null ? `with ${key}` : `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`)),
  ];
  const folder = typeof input.folder === "string" && input.folder.trim() ? ` in ${fileLabel(input.folder)}` : "";
  return `${parts.join(", ")}${folder}`;
}

/** A web address as short as it reads well: "example.com/docs/intro". */
function pageLabel(url: unknown): string {
  if (typeof url !== "string") return "a web page";
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname.replace(/\/+$/, "");
    return `${hostname.replace(/^www\./, "")}${path.length > 30 ? `${path.slice(0, 29)}…` : path}`;
  } catch {
    return "a web page";
  }
}

/** What the tool works on, as the label names it ("" when the verb says it all). */
function subject(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "search_vault":
      return `"${typeof input.query === "string" ? input.query : ""}"`;
    case "list_files":
      return typeof input.path === "string" && input.path.trim() ? fileLabel(input.path) : "the vault";
    case "rename_file":
      return `${fileLabel(input.path)} to ${fileLabel(input.new_path)}`;
    case "get_current_datetime":
      return "the date";
    case "ask_user":
      return "";
    case "query_notes":
      return noteFilter(input);
    case "list_metadata":
      return typeof input.folder === "string" && input.folder.trim() ? fileLabel(input.folder) : "the vault";
    case "read_web_page":
      return pageLabel(input.url);
    case "use_skill":
      return typeof input.name === "string" ? input.name.replace(/^\//, "") : "";
    default:
      return fileLabel(input.path);
  }
}

export function toolLabel(name: string, input: Record<string, unknown> = {}, state: ToolState = "done"): string {
  // A tool the provider called on an MCP server: "mcp:<server>:<tool>" (`api/mcp.ts`).
  const mcp = /^mcp:([^:]*):(.*)$/.exec(name);
  if (mcp) {
    const [, server, tool] = mcp;
    if (state === "running") return `Using ${tool} on ${server}…`;
    return state === "error" ? `Using ${tool} on ${server} failed` : `Used ${tool} on ${server}`;
  }
  const verbs = VERBS[name];
  if (!verbs) {
    const plain = name.replace(/_/g, " ");
    return state === "running" ? `${plain}…` : state === "error" ? `${plain} failed` : plain;
  }
  const [present, past] = verbs;
  const what = subject(name, input);
  const [doing, done] = what ? [`${present} ${what}`, `${past} ${what}`] : [present, past];
  if (state === "running") return `${doing}…`;
  if (state === "error") return `${doing} failed`;
  return done;
}
