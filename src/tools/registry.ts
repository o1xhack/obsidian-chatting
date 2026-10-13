import type { UnifiedToolDef } from "../types";

/**
 * The tools the agent can call: notes, canvases, images, web pages, skills
 * and ask_user. Each has a case in `executeTool` and a label in
 * `ui/tool-label.ts`.
 */
export const TOOL_DEFINITIONS: UnifiedToolDef[] = [
  {
    name: "read_document",
    description:
      "Read the content of a markdown document. If no path is given, reads the currently active document. For .canvas files use read_canvas. Images, PDFs and other binary files are refused (use view_image or read_file).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document relative to vault root. Omit to read the active document.",
        },
      },
      required: [],
    },
  },
  {
    name: "edit_document",
    description:
      "Edit a markdown document (for .canvas files use edit_canvas instead). Supports three operations: 'replace_all' replaces the entire content, 'find_replace' finds a specific string and replaces it, 'insert' adds content at a position.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to edit the active document.",
        },
        operation: {
          type: "string",
          enum: ["replace_all", "find_replace", "insert"],
          description: "The type of edit to perform.",
        },
        content: {
          type: "string",
          description: "The new content (for replace_all), replacement text (for find_replace), or text to insert.",
        },
        find: {
          type: "string",
          description: "The exact text to find (required for find_replace).",
        },
        position: {
          type: "string",
          enum: ["beginning", "end", "after_frontmatter"],
          description: "Where to insert content (required for insert). 'after_frontmatter' inserts after the --- block.",
        },
      },
      required: ["operation", "content"],
    },
  },
  {
    name: "search_vault",
    description:
      "Search notes and canvases by filename or content. In canvases, content search covers card text, group labels and edge labels and reports the node or edge ID. Returns matching file paths and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (matched against filenames and optionally content).",
        },
        searchContent: {
          type: "boolean",
          description: "Whether to also search inside file contents (slower). Default: false.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Default: 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read a file in the vault by its path: a text file's full content, or a PDF, Word, Excel or PowerPoint file (attached for you to read, up to 10 MB). Refuses images (use view_image) and other binary files. For .canvas files prefer read_canvas, which is shorter and easier to follow.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "view_image",
    description:
      "Look at an image file in the vault (PNG, JPEG, GIF or WebP): returns the image itself so you can see it. Large images are scaled down. Use this for any question about what an image in the vault shows.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the image relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_canvas",
    description:
      "Read an Obsidian canvas (.canvas file) as a compact outline: each group with the nodes inside it, then nodes outside groups, then edges as 'fromId → toId: label'. Shows node IDs, type, text (shortened) / file / URL, position (top-left x,y) and size. Use the IDs with edit_canvas. To see the layout as a picture, use view_canvas.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the .canvas file relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "view_canvas",
    description:
      "Look at an Obsidian canvas (.canvas file) as a picture: returns a PNG of the layout (groups, cards, files with images drawn, links, edges with arrows and labels, colours) plus a legend mapping the ID tag drawn on each node to its type and first words. Use it to understand the visual arrangement or to check a layout after edit_canvas; use read_canvas for the full text. Large canvases are scaled to fit; set 'focus' to zoom to one group or node.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the .canvas file relative to vault root.",
        },
        focus: {
          type: "string",
          description: "ID of a group or node to zoom to (or its tag from an earlier picture). Omit to show the whole canvas.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_canvas",
    description:
      "Change an Obsidian canvas (.canvas file) with structured operations, applied in order and all-or-nothing (on any error nothing is written). Generates node and edge IDs, keeps the file valid JSON Canvas, places new nodes without overlapping others, and keeps unknown fields. Read the canvas with read_canvas first. Operations: add_node, update_node, move_node, remove_node (also removes its edges), add_edge, update_edge, remove_edge. To create a new canvas, create_file with content '{\"nodes\":[],\"edges\":[]}' and then use this tool.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the .canvas file relative to vault root.",
        },
        operations: {
          type: "array",
          description: "Operations to apply in order.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["add_node", "update_node", "move_node", "remove_node", "add_edge", "update_edge", "remove_edge"],
              },
              id: {
                type: "string",
                description: "Node or edge ID (or ref) to update, move or remove.",
              },
              ref: {
                type: "string",
                description: "add_node/add_edge: a temporary name for the new node or edge, usable as id, near, group, fromNode or toNode in later operations of this call.",
              },
              type: {
                type: "string",
                enum: ["text", "file", "link", "group"],
                description: "add_node: the node type.",
              },
              text: { type: "string", description: "Markdown text of a text node." },
              file: { type: "string", description: "Vault path of a file node; the file must exist." },
              subpath: { type: "string", description: "Heading or block in the file, e.g. '#Heading'. Empty string removes it." },
              url: { type: "string", description: "URL of a link node." },
              label: { type: "string", description: "Label of a group or an edge. Empty string removes it." },
              color: { type: "string", description: "'1'-'6' (red, orange, yellow, green, cyan, purple) or hex like '#FF0000'. Empty string removes it." },
              x: { type: "number", description: "add_node/move_node: left edge. Omit to place automatically." },
              y: { type: "number", description: "add_node/move_node: top edge. Omit to place automatically." },
              width: { type: "number", description: "add_node/update_node: width. add_node has a default per type." },
              height: { type: "number", description: "add_node/update_node: height. add_node has a default per type." },
              near: { type: "string", description: "add_node/move_node: put the node next to this node, without overlapping others." },
              side: {
                type: "string",
                enum: ["top", "right", "bottom", "left"],
                description: "Which side of 'near' to use. Default: right.",
              },
              group: { type: "string", description: "add_node/move_node: put the node inside this group; the group grows if needed." },
              fromNode: { type: "string", description: "add_edge/update_edge: start node ID or ref." },
              toNode: { type: "string", description: "add_edge/update_edge: end node ID or ref." },
              fromSide: { type: "string", enum: ["top", "right", "bottom", "left"], description: "Default: the side facing the other node." },
              toSide: { type: "string", enum: ["top", "right", "bottom", "left"], description: "Default: the side facing the other node." },
              fromEnd: { type: "string", enum: ["none", "arrow"], description: "Default: none." },
              toEnd: { type: "string", enum: ["none", "arrow"], description: "Default: arrow." },
            },
            required: ["op"],
          },
        },
      },
      required: ["path", "operations"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file in the vault. Fails if the file already exists. IMPORTANT: The filename is the title in Obsidian, so never start content with an H1 heading that repeats the filename.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path for the new file relative to vault root (e.g. 'Notes/meeting.md').",
        },
        content: {
          type: "string",
          description: "Content of the new file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in the vault, optionally filtered by folder and/or extension.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Folder path to list (e.g. 'Projects'). Omit to list all files.",
        },
        extension: {
          type: "string",
          description: "Filter by file extension (e.g. 'md'). Omit to include all types.",
        },
      },
      required: [],
    },
  },
  {
    name: "rename_file",
    description: "Rename or move a file in the vault. Can be used to rename a note or move it to a different folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Current path of the file relative to vault root.",
        },
        new_path: {
          type: "string",
          description: "New path for the file relative to vault root.",
        },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "delete_file",
    description: "Move a file to the Obsidian trash. Use with caution.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file to delete relative to vault root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "get_properties",
    description:
      "Read the YAML frontmatter properties of a markdown document as structured data. Returns tags, aliases, and all custom properties.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to use the active document.",
        },
      },
      required: [],
    },
  },
  {
    name: "set_properties",
    description:
      "Set or update YAML frontmatter properties on a markdown document. Merges with existing properties. Set a value to null to remove a property.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to use the active document.",
        },
        properties: {
          type: "object",
          description: "Key-value pairs to set in the frontmatter. Arrays (like tags) are supported. Set a value to null to remove that property.",
        },
      },
      required: ["properties"],
    },
  },
  {
    name: "query_notes",
    description:
      "Find notes by tags and properties (frontmatter), e.g. all notes tagged #project with status 'active', sorted by due date. Uses Obsidian's metadata cache, so it is fast and reads no note. Returns paths with each note's tags and the properties asked about. Use list_metadata first if you don't know which tags or properties exist.",
    inputSchema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags the notes must have, with or without '#'. A tag also matches its nested tags (#project matches #project/alpha).",
        },
        match: {
          type: "string",
          enum: ["all", "any"],
          description: "Whether notes need all of the tags (default) or any of them.",
        },
        properties: {
          type: "object",
          description: "Property filters: name → value. A note matches when the property equals the value (case-insensitive; for list properties, when the list contains it; links match their note name). Use null to require only that the property is set.",
        },
        folder: {
          type: "string",
          description: "Only notes in this folder (and its subfolders).",
        },
        sort_by: {
          type: "string",
          description: "'path' (default), 'modified' (newest first), or a property name (ascending; notes without it last).",
        },
        limit: {
          type: "number",
          description: "Maximum notes listed (default 50, max 200).",
        },
      },
      required: [],
    },
  },
  {
    name: "list_metadata",
    description:
      "List the tags and property names used in the vault (or a folder), with how many notes use each and an example value per property. Use it to learn the vault's tags and properties before query_notes.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Only notes in this folder (and its subfolders).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_links",
    description:
      "A note's links, like Obsidian's Backlinks and Outgoing links panes: linked mentions (notes that link to it, with the lines), unlinked mentions (notes whose text names it or an alias without a link, any case) and outgoing links (including links to notes that don't exist yet).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the document. Omit to use the active document.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_current_datetime",
    description:
      "Get the current date and time in the user's local timezone. Useful for daily notes, journaling, scheduling, or any time-aware task.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "open_document",
    description:
      "Show the user a note or canvas: opens it in the main area and, with `text`, scrolls to and highlights that text; with `node_id`, selects that canvas card. Use this only when the user explicitly asks to open, show or go to something; never to show your own work (the user's view follows your edits by itself when they want that).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to vault root.",
        },
        text: {
          type: "string",
          description: "Optional: exact text in the note to scroll to and highlight (a heading or a passage).",
        },
        node_id: {
          type: "string",
          description: "Optional: ID of the canvas card to select and pan to (from read_canvas).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a clarifying question. Use this when you need more information before proceeding. The conversation will pause until the user responds.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "read_web_page",
    description:
      "Read a web page at a URL: returns its main content as Markdown (navigation, scripts and the like left out), or the text of a plain-text, Markdown or JSON address. Use it for links the user gives or pages a web search found. Long pages come in parts: call again with 'start' to continue. Pages that need JavaScript to show their content come back empty.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full http(s) address.",
        },
        start: {
          type: "number",
          description: "Character to start at, for the next part of a long page (default 0).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "use_skill",
    description:
      "Load a skill from the vault: its instructions and the list of its other files. Call it before a task that matches a skill listed in the system prompt, then follow the instructions.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill's name as listed.",
        },
      },
      required: ["name"],
    },
  },
];
