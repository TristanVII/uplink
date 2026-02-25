import { createInterface } from "node:readline";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcMessage,
  InitializeResult,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionUpdateParams,
  SessionUpdate,
  PermissionOutcome,
  PlanEntry,
  ContentBlock,
} from "../shared/acp-types.js";
import {
  createRequest,
  createNotification,
  parseMessage,
} from "../shared/acp-types.js";

// ─── State ────────────────────────────────────────────────────────────

let sessionId = "";
let nextId = 1000;
const pendingPermissions = new Map<
  number | string,
  (outcome: PermissionOutcome) => void
>();

// ─── I/O ──────────────────────────────────────────────────────────────

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResponse(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendNotification(method: string, params: unknown): void {
  send(createNotification(method, params));
}

function sendSessionUpdate(update: SessionUpdate): void {
  sendNotification("session/update", {
    sessionId,
    update,
  } satisfies SessionUpdateParams);
}

function sendChunk(text: string): void {
  sendSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Scenarios ────────────────────────────────────────────────────────

async function scenarioSimpleText(requestId: number | string): Promise<void> {
  sendChunk("Hello ");
  await delay(50);
  sendChunk("from ");
  await delay(50);
  sendChunk("mock agent!");
  sendResponse(requestId, { stopReason: "end_turn" } satisfies SessionPromptResult);
}

async function scenarioToolCall(requestId: number | string): Promise<void> {
  sendSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc1",
    title: "Reading file",
    kind: "read",
    status: "pending",
  });
  await delay(50);
  sendSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc1",
    status: "in_progress",
  });
  await delay(50);
  sendSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc1",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "File contents here" } },
    ],
  });
  sendChunk("Tool completed successfully.");
  sendResponse(requestId, { stopReason: "end_turn" } satisfies SessionPromptResult);
}

async function scenarioPermission(requestId: number | string): Promise<void> {
  sendSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc2",
    title: "Writing file",
    kind: "edit",
    status: "pending",
  });

  const permId = nextId++;
  const outcome = await new Promise<PermissionOutcome>((resolve) => {
    pendingPermissions.set(permId, resolve);
    send(
      createRequest(permId, "session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: "tc2",
          title: "Writing file",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      }),
    );
  });

  if (outcome.outcome === "selected" && outcome.optionId === "allow") {
    sendSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc2",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "File written." } },
      ],
    });
    sendChunk("Permission granted, file written.");
  } else {
    sendSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc2",
      status: "failed",
    });
    sendChunk("Permission denied.");
  }

  sendResponse(requestId, { stopReason: "end_turn" } satisfies SessionPromptResult);
}

async function scenarioMultiChunkStream(
  requestId: number | string,
): Promise<void> {
  const words = [
    "The ", "quick ", "brown ", "fox ", "jumps ",
    "over ", "the ", "lazy ", "dog. ", "This ",
    "is ", "a ", "streaming ", "test ", "with ",
    "twenty ", "words ", "sent ", "one ", "at-a-time. ",
  ];
  for (const word of words) {
    sendChunk(word);
    await delay(10);
  }
  sendResponse(requestId, { stopReason: "end_turn" } satisfies SessionPromptResult);
}

async function scenarioPlanThenExecute(
  requestId: number | string,
): Promise<void> {
  const entries: PlanEntry[] = [
    { content: "Read configuration", priority: "high", status: "pending" },
    { content: "Apply changes", priority: "high", status: "pending" },
    { content: "Verify results", priority: "medium", status: "pending" },
  ];

  sendSessionUpdate({ sessionUpdate: "plan", entries: [...entries] });

  sendSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "plan-tc1",
    title: "Read configuration",
    kind: "read",
    status: "pending",
  });
  await delay(50);

  entries[0].status = "completed";
  entries[1].status = "in_progress";
  sendSessionUpdate({ sessionUpdate: "plan", entries: [...entries] });

  sendSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "plan-tc1",
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "Config read." } },
    ],
  });

  sendChunk("Plan execution complete.");
  sendResponse(requestId, { stopReason: "end_turn" } satisfies SessionPromptResult);
}

function scenarioRefusal(requestId: number | string): void {
  sendChunk("I cannot do that.");
  sendResponse(requestId, { stopReason: "refusal" } satisfies SessionPromptResult);
}

// ─── Message Router ───────────────────────────────────────────────────

function extractPromptText(params: SessionPromptParams): string {
  const textBlock = params.prompt.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  return textBlock?.text.trim().toLowerCase() ?? "";
}

async function handleRequest(msg: JsonRpcRequest): Promise<void> {
  switch (msg.method) {
    case "initialize": {
      const result: InitializeResult = {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "mock-agent", version: "0.1.0" },
        authMethods: [],
      };
      sendResponse(msg.id, result);
      break;
    }
    case "session/new": {
      sessionId = `mock-session-${Date.now()}`;
      sendResponse(msg.id, { sessionId } satisfies SessionNewResult);
      break;
    }
    case "session/prompt": {
      const params = msg.params as SessionPromptParams;
      const text = extractPromptText(params);

      if (text.startsWith("tool")) {
        await scenarioToolCall(msg.id);
      } else if (text.startsWith("permission")) {
        await scenarioPermission(msg.id);
      } else if (text.startsWith("stream")) {
        await scenarioMultiChunkStream(msg.id);
      } else if (text.startsWith("plan")) {
        await scenarioPlanThenExecute(msg.id);
      } else if (text.startsWith("refuse")) {
        scenarioRefusal(msg.id);
      } else {
        await scenarioSimpleText(msg.id);
      }
      break;
    }
    case "session/cancel": {
      // Acknowledge cancellation — no response needed (notification-like)
      break;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
}

function handleResponse(msg: JsonRpcResponse): void {
  if ("error" in msg && msg.error) {
    // Permission request was rejected with an error
    const resolver = pendingPermissions.get(msg.id!);
    if (resolver) {
      pendingPermissions.delete(msg.id!);
      resolver({ outcome: "cancelled" });
    }
    return;
  }

  const result = msg.result as { outcome: PermissionOutcome } | undefined;
  if (result?.outcome && msg.id != null) {
    const resolver = pendingPermissions.get(msg.id);
    if (resolver) {
      pendingPermissions.delete(msg.id);
      resolver(result.outcome);
    }
  }
}

function handleLine(line: string): void {
  if (!line.trim()) return;

  let msg: JsonRpcMessage;
  try {
    msg = parseMessage(line);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  if ("result" in msg || "error" in msg) {
    handleResponse(msg as JsonRpcResponse);
  } else if ("id" in msg) {
    handleRequest(msg as JsonRpcRequest);
  }
  // Notifications without id are silently accepted
}

// ─── Self-Test ────────────────────────────────────────────────────────

async function selfTest(): Promise<void> {
  console.log("Self-test: verifying message helpers...");

  const req = createRequest(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  if (req.jsonrpc !== "2.0" || req.id !== 1) throw new Error("createRequest failed");

  const notif = createNotification("session/update", {});
  if ("id" in notif) throw new Error("createNotification should not have id");

  const parsed = parseMessage(JSON.stringify(req));
  if (!("method" in parsed) || parsed.method !== "initialize")
    throw new Error("parseMessage failed");

  console.log("Self-test: all checks passed.");
}

// ─── Entry Point ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  selfTest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else if (args.includes("--acp") && args.includes("--stdio")) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => handleLine(line));
  rl.on("close", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} else {
  console.error("Usage: mock-agent --acp --stdio");
  console.error("       mock-agent --self-test");
  process.exit(1);
}
