/* global React, ReactDOM, antd, marked, DOMPurify, AgentHttpApi, AgentHttpSse */
(function () {
  const e = React.createElement;
  const { useEffect, useRef, useState } = React;
  const { Button, Input, Select, message } = antd;

  if (typeof marked !== "undefined" && marked.setOptions) {
    marked.setOptions({
      gfm: true,
      breaks: true,
    });
  }

  function pushText(parts, text) {
    if (typeof text !== "string") return;
    const trimmed = text.replace(/\s+$/g, "");
    if (!trimmed) return;
    parts.push({ kind: "text", text: trimmed });
  }

  function textOf(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (typeof node.text === "string") return node.text;
    if (typeof node.content === "string") return node.content;
    return "";
  }

  function humanizeToolName(name) {
    return String(name || "tool")
      .replace(/ToolCall$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .trim();
  }

  /** Cursor stores tools as `{ getMcpToolsToolCall: { args, result, ... } }`. */
  function parseToolCall(toolCall) {
    if (!toolCall || typeof toolCall !== "object") return null;
    if (typeof toolCall.name === "string" || typeof toolCall.toolName === "string") {
      return {
        name: toolCall.name || toolCall.toolName,
        args: toolCall.args,
        result: toolCall.result,
        status: toolCall.status || (toolCall.result ? "completed" : "running"),
        toolCallId: toolCall.toolCallId || toolCall.call_id || toolCall.id,
      };
    }
    const keys = Object.keys(toolCall);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!/ToolCall$/.test(key) && key !== "tool") continue;
      const payload = toolCall[key];
      if (!payload || typeof payload !== "object") {
        return {
          name: key.replace(/ToolCall$/, "") || "tool",
          status: "completed",
        };
      }
      return {
        name: key.replace(/ToolCall$/, "") || "tool",
        args: payload.args,
        result: payload.result,
        status:
          payload.status ||
          (payload.completedAtMs || payload.result ? "completed" : "running"),
        toolCallId: payload.toolCallId || toolCall.toolCallId,
        durationMs:
          payload.startedAtMs && payload.completedAtMs
            ? Number(payload.completedAtMs) - Number(payload.startedAtMs)
            : undefined,
      };
    }
    return {
      name: "tool",
      args: toolCall,
      status: "completed",
    };
  }

  function summarizeJson(value, max) {
    if (value == null) return "";
    try {
      const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (raw.length <= (max || 1200)) return raw;
      return raw.slice(0, max || 1200) + "\n…";
    } catch (_) {
      return String(value);
    }
  }

  /**
   * Cursor persists a whole turn under one `user` row:
   * agentConversationTurn.userMessage + steps[].assistantMessage / thinkingMessage / toolCall
   */
  function expandApiMessages(items) {
    const out = [];
    (items || []).forEach(function (m, idx) {
      const content = m && m.content;
      const turn = content && content.agentConversationTurn;
      if (turn && typeof turn === "object") {
        const base = String(m.id || idx);
        const userText = textOf(turn.userMessage);
        if (userText) {
          out.push({ id: base + ":user", role: "user", content: userText });
        }
        (turn.steps || []).forEach(function (step, si) {
          if (!step || typeof step !== "object") return;
          const thinking = textOf(step.thinkingMessage);
          if (thinking) {
            out.push({
              id: base + ":think:" + si,
              role: "thinking",
              content: {
                text: thinking,
                durationMs: step.thinkingMessage && step.thinkingMessage.durationMs,
              },
            });
          }
          const tool = parseToolCall(
            step.toolCall || step.tool_call || step.toolCallMessage || step.toolMessage,
          );
          if (tool) {
            out.push({
              id: base + ":tool:" + si,
              role: "tool",
              content: tool,
            });
          }
          const assistant = textOf(step.assistantMessage);
          if (assistant) {
            out.push({
              id: base + ":assistant:" + si,
              role: "assistant",
              content: assistant,
            });
          }
        });
        const tailAssistant = textOf(turn.assistantMessage);
        if (tailAssistant) {
          out.push({
            id: base + ":assistant:tail",
            role: "assistant",
            content: tailAssistant,
          });
        }
        return;
      }
      out.push({
        id: m.id || "msg-" + idx,
        role: m.role || "assistant",
        content: content,
      });
    });
    return out;
  }

  function messageParts(msg) {
    const parts = [];
    const content = msg && msg.content;
    if (msg && msg.role === "tool" && content && typeof content === "object") {
      parts.push({ kind: "tool", tool: content });
      return parts;
    }
    if (msg && msg.role === "thinking") {
      if (content && typeof content === "object" && content.text) {
        parts.push({
          kind: "thinking",
          text: content.text,
          durationMs: content.durationMs,
        });
      } else if (typeof content === "string") {
        parts.push({ kind: "thinking", text: content });
      }
      return parts;
    }
    if (typeof content === "string") {
      pushText(parts, content);
      return parts;
    }
    if (content && typeof content.text === "string") {
      pushText(parts, content.text);
      return parts;
    }
    if (Array.isArray(content)) {
      content.forEach(function (part) {
        if (typeof part === "string") pushText(parts, part);
        else if (part && typeof part.text === "string") pushText(parts, part.text);
      });
      if (parts.length) return parts;
    }
    if (content != null) {
      try {
        parts.push({ kind: "text", text: JSON.stringify(content, null, 2) });
      } catch (_) {
        parts.push({ kind: "text", text: String(content) });
      }
    }
    return parts;
  }

  function renderMarkdown(text) {
    const source = String(text ?? "");
    let html = source;
    try {
      if (typeof marked !== "undefined") {
        html = typeof marked.parse === "function" ? marked.parse(source) : marked(source);
      } else {
        html = source
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br/>");
      }
      if (typeof DOMPurify !== "undefined") {
        html = DOMPurify.sanitize(html);
      }
    } catch (_) {
      html = source
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br/>");
    }
    return e("div", {
      className: "md-body",
      dangerouslySetInnerHTML: { __html: html },
    });
  }

  function roleLabel(role) {
    if (role === "user") return "You";
    if (role === "assistant") return "Agent";
    if (role === "thinking") return "Thinking";
    if (role === "tool") return "Tool";
    return role || "message";
  }

  function ToolCard(props) {
    const tool = props.tool || {};
    const [open, setOpen] = useState(false);
    const name = humanizeToolName(tool.name || "tool");
    const status = String(tool.status || "completed");
    const hasDetails = tool.args != null || tool.result != null;
    return e(
      "div",
      { className: "tool-card status-" + status },
      e(
        "button",
        {
          type: "button",
          className: "tool-card-head",
          onClick: function () {
            if (hasDetails) setOpen(function (v) {
              return !v;
            });
          },
        },
        e("span", { className: "tool-card-icon", "aria-hidden": "true" }, "⚒"),
        e("span", { className: "tool-card-name" }, name),
        e("span", { className: "tool-card-status" }, status),
        hasDetails
          ? e("span", { className: "tool-card-chevron" }, open ? "▾" : "▸")
          : null,
      ),
      open
        ? e(
            "div",
            { className: "tool-card-body" },
            tool.args != null
              ? e(
                  "div",
                  { className: "tool-card-section" },
                  e("div", { className: "tool-card-label" }, "Args"),
                  e("pre", null, summarizeJson(tool.args)),
                )
              : null,
            tool.result != null
              ? e(
                  "div",
                  { className: "tool-card-section" },
                  e("div", { className: "tool-card-label" }, "Result"),
                  e("pre", null, summarizeJson(tool.result)),
                )
              : null,
          )
        : null,
    );
  }

  function ThinkingCard(props) {
    const [open, setOpen] = useState(false);
    const text = props.text || "";
    const durationMs = props.durationMs;
    return e(
      "div",
      { className: "thinking-card" },
      e(
        "button",
        {
          type: "button",
          className: "thinking-card-head",
          onClick: function () {
            setOpen(function (v) {
              return !v;
            });
          },
        },
        e("span", { className: "thinking-card-title" }, "Thinking"),
        durationMs != null
          ? e("span", { className: "thinking-card-meta" }, durationMs + "ms")
          : null,
        e("span", { className: "thinking-card-chevron" }, open ? "▾" : "▸"),
      ),
      open
        ? e("div", { className: "thinking-card-body" }, text)
        : e(
            "div",
            { className: "thinking-card-preview" },
            text.length > 120 ? text.slice(0, 120) + "…" : text,
          ),
    );
  }

  function formatTime(value) {
    if (value == null) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function sessionTitle(item) {
    if (item.name && String(item.name).trim()) return String(item.name).trim();
    const id = String(item.id || "");
    return id.length > 18 ? id.slice(0, 10) + "…" + id.slice(-6) : id || "未命名会话";
  }

  function App() {
    const [cwd, setCwd] = useState("");
    const [model, setModel] = useState("composer-2.5");
    const [models, setModels] = useState([{ id: "composer-2.5" }]);
    const [sessionId, setSessionId] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [prompt, setPrompt] = useState("");
    const [messages, setMessages] = useState([]);
    const [streaming, setStreaming] = useState(false);
    const [liveText, setLiveText] = useState("");
    const [editingId, setEditingId] = useState(null);
    const [editingName, setEditingName] = useState("");
    const [mcpOpen, setMcpOpen] = useState(false);
    const [mcpJson, setMcpJson] = useState(function () {
      try {
        const raw = localStorage.getItem("agent-gateway.mcpServers");
        if (raw && raw.trim()) return raw;
      } catch (_) {
        /* ignore */
      }
      return "{\n  \n}";
    });
    const [mcpError, setMcpError] = useState("");
    const abortRef = useRef(null);
    const bottomRef = useRef(null);
    const cwdRef = useRef("");
    const streamingRef = useRef(false);
    const sessionIdRef = useRef(null);

    useEffect(function () {
      cwdRef.current = cwd;
    }, [cwd]);

    useEffect(function () {
      streamingRef.current = streaming;
    }, [streaming]);

    function bindSessionId(id) {
      sessionIdRef.current = id || null;
      setSessionId(id || null);
    }

    function currentSessionMeta() {
      const id = sessionIdRef.current || sessionId;
      if (!id) return null;
      for (let i = 0; i < sessions.length; i++) {
        if (sessions[i].id === id) return sessions[i];
      }
      return null;
    }

    function isSessionBusy(meta) {
      if (!meta) return false;
      if (meta.activeRunId) return true;
      const status = String(meta.status || "").toLowerCase();
      return status !== "" && status !== "idle" && status !== "finished";
    }

    // Frontend-only routing: non-idle → steer; has sessionId + idle → resume; else create.
    function shouldSteer() {
      const id = sessionIdRef.current || sessionId;
      if (!id) return false;
      if (streaming) return true;
      return isSessionBusy(currentSessionMeta());
    }

    function parseMcpServers() {
      const raw = (mcpJson || "").trim();
      if (!raw || raw === "{" || raw === "{\n  \n}") {
        setMcpError("");
        return undefined;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("mcpServers 必须是 JSON 对象");
        }
        const keys = Object.keys(parsed);
        if (!keys.length) {
          setMcpError("");
          return undefined;
        }
        setMcpError("");
        try {
          localStorage.setItem("agent-gateway.mcpServers", JSON.stringify(parsed, null, 2));
        } catch (_) {
          /* ignore */
        }
        return parsed;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        setMcpError(msg);
        throw new Error("mcpServers JSON 无效: " + msg);
      }
    }

    async function refreshSessions(workspace) {
      const path = (workspace != null ? workspace : cwdRef.current || "").trim();
      if (!path) {
        setSessions([]);
        return;
      }
      setSessionsLoading(true);
      try {
        const data = await AgentHttpApi.listSessions(path, 50);
        setSessions(data.items || []);
      } catch (err) {
        message.error(err.message || String(err));
      } finally {
        setSessionsLoading(false);
      }
    }

    useEffect(function () {
      AgentHttpApi.fetchUiConfig()
        .then(function (cfg) {
          AgentHttpApi.setToken(cfg.token);
          const nextCwd = cfg.defaultCwd || "";
          setCwd(nextCwd);
          cwdRef.current = nextCwd;
          return Promise.all([AgentHttpApi.listModels(), AgentHttpApi.listSessions(nextCwd, 50)]);
        })
        .then(function (pair) {
          const items = pair[0];
          const listed = pair[1];
          if (items && items.length) {
            setModels(items);
            setModel(items[0].id);
          }
          setSessions((listed && listed.items) || []);
        })
        .catch(function (err) {
          message.error(err.message || String(err));
        });
    }, []);

    useEffect(
      function () {
        if (!cwd.trim()) return undefined;
        const timer = setTimeout(function () {
          refreshSessions(cwd);
        }, 400);
        return function () {
          clearTimeout(timer);
        };
      },
      [cwd],
    );

    useEffect(
      function () {
        if (bottomRef.current) {
          bottomRef.current.scrollIntoView({ behavior: "smooth" });
        }
      },
      [messages, liveText],
    );

    async function reloadSession(id, workspace) {
      const detail = await AgentHttpApi.getSession(id, workspace);
      setMessages(expandApiMessages(detail.messages || []));
      return detail;
    }

    /** Leave current SSE viewer without cancelling the agent run. */
    function detachStream() {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch (_) {
          /* ignore */
        }
        abortRef.current = null;
      }
      streamingRef.current = false;
      setStreaming(false);
      setLiveText("");
    }

    async function onSelectSession(id) {
      if (!id) return;
      if (!cwd.trim()) {
        message.warning("请填写工作区路径");
        return;
      }

      const same = id === sessionIdRef.current;
      // Already watching this session's live stream — keep it.
      if (same && streamingRef.current) return;

      // Switching away: drop local SSE only; server run keeps going.
      if (!same) detachStream();

      try {
        bindSessionId(id);
        setEditingId(null);
        setLiveText("");
        const detail = await reloadSession(id, cwd);
        const sess = (detail && detail.session) || {};
        setSessions(function (prev) {
          return prev.map(function (item) {
            if (item.id !== id) return item;
            return Object.assign({}, item, sess);
          });
        });

        // Active run → reconnect SSE (replay buffer + live).
        // Also try once when status lags behind the in-process bus.
        if (isSessionBusy(sess)) {
          void attachConnect(id, { quiet: false });
        } else {
          void attachConnect(id, { quiet: true });
        }
      } catch (err) {
        message.error(err.message || String(err));
      }
    }

    async function consumeSse(res, viewingSessionId) {
      let currentSession = viewingSessionId || sessionIdRef.current;
      let assistant = "";
      let liveThinkId = null;

      function stillViewing() {
        return sessionIdRef.current === viewingSessionId;
      }

      await AgentHttpSse.readSse(res, function (eventName, data) {
        if (!stillViewing()) return;

        if (data && data.sessionId) {
          if (data.sessionId !== currentSession || !sessionIdRef.current) {
            currentSession = data.sessionId;
            bindSessionId(currentSession);
          }
        }
        if (eventName === "message" && data) {
          if (data.type === "thinking") {
            const text = typeof data.text === "string" ? data.text : "";
            if (!text) return;
            if (!liveThinkId) {
              liveThinkId = "live-think-" + Date.now();
              setMessages(function (prev) {
                return prev.concat([
                  {
                    id: liveThinkId,
                    role: "thinking",
                    content: {
                      text: text,
                      durationMs: data.thinking_duration_ms,
                    },
                  },
                ]);
              });
            } else {
              const thinkId = liveThinkId;
              setMessages(function (prev) {
                return prev.map(function (item) {
                  if (item.id !== thinkId) return item;
                  const prevText =
                    item.content && item.content.text ? item.content.text : "";
                  const next =
                    text.length >= prevText.length ? text : prevText + text;
                  return Object.assign({}, item, {
                    content: {
                      text: next,
                      durationMs: data.thinking_duration_ms,
                    },
                  });
                });
              });
            }
          } else if (data.type === "tool_call") {
            liveThinkId = null;
            const tool = parseToolCall(data) || {
              name: data.name || "tool",
              args: data.args,
              result: data.result,
              status: data.status || "running",
              toolCallId: data.call_id,
            };
            const toolId =
              "live-tool-" + (tool.toolCallId || tool.name || Date.now());
            setMessages(function (prev) {
              const idx = prev.findIndex(function (item) {
                return item.id === toolId;
              });
              const nextItem = { id: toolId, role: "tool", content: tool };
              if (idx < 0) return prev.concat([nextItem]);
              const copy = prev.slice();
              copy[idx] = nextItem;
              return copy;
            });
          } else if (data.type === "assistant") {
            liveThinkId = null;
            const chunk = AgentHttpSse.assistantTextFromMessage(data);
            if (chunk) {
              assistant = chunk.length >= assistant.length ? chunk : assistant + chunk;
              setLiveText(assistant);
            }
          }
        }
        if (eventName === "error") {
          message.error((data && data.message) || "stream error");
        }
      });
      return { currentSession: currentSession, assistant: assistant };
    }

    async function finishStream(currentSession, assistant) {
      if (currentSession) {
        bindSessionId(currentSession);
        await reloadSession(currentSession, cwdRef.current);
        await refreshSessions(cwdRef.current);
      } else if (assistant) {
        setMessages(function (prev) {
          return prev.concat([
            { id: "assistant-" + Date.now(), role: "assistant", content: assistant },
          ]);
        });
      }
      setLiveText("");
    }

    async function attachConnect(targetSessionId, options) {
      const quiet = !!(options && options.quiet);
      if (!targetSessionId) return;
      if (streamingRef.current && sessionIdRef.current === targetSessionId) return;

      // Replace any previous viewer for another session.
      if (streamingRef.current) detachStream();

      const ac = new AbortController();
      abortRef.current = ac;
      const viewingId = targetSessionId;
      setStreaming(true);
      setLiveText("");
      try {
        const res = await AgentHttpApi.chatConnect(
          { sessionId: targetSessionId },
          ac.signal,
        );
        if (!res.ok) {
          if (!quiet) {
            const err = await res.json().catch(function () {
              return {};
            });
            throw new Error(err.message || err.error || res.statusText);
          }
          return;
        }
        const out = await consumeSse(res, viewingId);
        if (sessionIdRef.current !== viewingId) return;
        await finishStream(out.currentSession || viewingId, out.assistant);
      } catch (err) {
        if (err && err.name === "AbortError") return;
        if (!quiet) message.error(err.message || String(err));
      } finally {
        if (sessionIdRef.current === viewingId) {
          setStreaming(false);
          abortRef.current = null;
        }
      }
    }

    async function onSend() {
      const text = prompt.trim();
      if (!text) return;
      if (!cwd.trim()) {
        message.warning("请填写工作区路径");
        return;
      }

      const activeId = sessionIdRef.current || sessionId;

      setPrompt("");
      setMessages(function (prev) {
        return prev.concat([{ id: "local-" + Date.now(), role: "user", content: text }]);
      });

      // Frontend-only: same session + busy/streaming → steer; keep SSE alive.
      if (activeId && shouldSteer()) {
        try {
          const result = await AgentHttpApi.chatSteer({
            sessionId: activeId,
            text: text,
          });
          if (result && result.outcome === "revert_to_followup") {
            message.info("当前无法 steer，改为续聊");
            if (!streamingRef.current) {
              await runPromptRequest(text);
            }
          } else if (!streamingRef.current) {
            // Session marked busy but we are not attached — reconnect.
            await attachConnect(activeId);
          }
          await refreshSessions(cwd);
        } catch (err) {
          message.error(err.message || String(err));
        }
        return;
      }

      await runPromptRequest(text);
    }

    async function runPromptRequest(text) {
      let mcpServers;
      try {
        mcpServers = parseMcpServers();
      } catch (err) {
        message.error(err.message || String(err));
        setMcpOpen(true);
        return;
      }

      const activeId = sessionIdRef.current || sessionId;
      const ac = new AbortController();
      abortRef.current = ac;
      setLiveText("");
      setStreaming(true);
      try {
        // Same session → resume; only create when there is no sessionId.
        const res = activeId
          ? await AgentHttpApi.chatResume(
              {
                sessionId: activeId,
                prompt: text,
                model: model,
                cwd: cwd,
                mcpServers: mcpServers,
              },
              ac.signal,
            )
          : await AgentHttpApi.chatCreate(
              {
                prompt: text,
                model: model,
                cwd: cwd,
                mcpServers: mcpServers,
              },
              ac.signal,
            );
        const out = await consumeSse(res, activeId);
        await finishStream(out.currentSession || activeId, out.assistant);
      } catch (err) {
        if (err && err.name !== "AbortError") {
          message.error(err.message || String(err));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    }

    async function commitRename(id) {
      const name = editingName.trim();
      setEditingId(null);
      if (!name || !id) return;
      try {
        const updated = await AgentHttpApi.renameSession(id, { name: name, cwd: cwd });
        setSessions(function (prev) {
          return prev.map(function (item) {
            if (item.id !== id) return item;
            return Object.assign({}, item, updated);
          });
        });
        message.success("已重命名");
      } catch (err) {
        message.error(err.message || String(err));
        await refreshSessions(cwd);
      }
    }

    async function onCancel() {
      const id = sessionIdRef.current || sessionId;
      detachStream();
      if (id) {
        try {
          await AgentHttpApi.chatCancel({ sessionId: id });
        } catch (_) {
          /* ignore */
        }
        await refreshSessions(cwdRef.current);
      }
    }

    function onNewChat() {
      // Leave live viewer; do not cancel the previous session's run.
      detachStream();
      bindSessionId(null);
      setMessages([]);
      setLiveText("");
    }

    const hasThread = messages.length > 0 || !!liveText;

    return e(
      "div",
      { className: "app" },
      e(
        "header",
        { className: "topbar" },
        e(
          "div",
          { className: "brand" },
          e("h1", { className: "brand-mark" }, "agent", e("span", null, "-gateway")),
          e("p", { className: "brand-sub" }, "本机多 harness 调试台 · REST + SSE"),
        ),
        e(
          "div",
          { className: "top-actions" },
          e(Button, { onClick: onNewChat }, "新会话"),
          streaming ? e(Button, { danger: true, onClick: onCancel }, "停止") : null,
        ),
      ),
      e(
        "div",
        { className: "workspace" },
        e(
          "aside",
          { className: "sidebar" },
          e(
            "div",
            { className: "sidebar-head" },
            e("span", { className: "field-label" }, "Sessions"),
            e(
              Button,
              {
                size: "small",
                loading: sessionsLoading,
                onClick: function () {
                  refreshSessions(cwd);
                },
              },
              "刷新",
            ),
          ),
          e(
            "div",
            { className: "session-list" },
            !sessions.length
              ? e(
                  "div",
                  { className: "session-empty" },
                  sessionsLoading ? "加载中…" : "当前工作区暂无会话",
                )
              : sessions.map(function (item) {
                  const active = item.id === sessionId;
                  const busy = isSessionBusy(item);
                  const renaming = editingId === item.id;
                  return e(
                    "div",
                    {
                      key: item.id,
                      className:
                        "session-item" +
                        (active ? " active" : "") +
                        (busy ? " busy" : ""),
                    },
                    renaming
                      ? e("input", {
                          className: "session-rename",
                          value: editingName,
                          autoFocus: true,
                          onChange: function (ev) {
                            setEditingName(ev.target.value);
                          },
                          onClick: function (ev) {
                            ev.stopPropagation();
                          },
                          onKeyDown: function (ev) {
                            if (ev.key === "Enter") {
                              ev.preventDefault();
                              commitRename(item.id);
                            }
                            if (ev.key === "Escape") {
                              setEditingId(null);
                            }
                          },
                          onBlur: function () {
                            commitRename(item.id);
                          },
                        })
                      :                           e(
                          "button",
                          {
                            type: "button",
                            className: "session-main",
                            onClick: function () {
                              onSelectSession(item.id);
                            },
                          },
                          e("div", { className: "session-title" }, sessionTitle(item)),
                          e(
                            "div",
                            { className: "session-meta" },
                            e("span", null, busy ? "running" : item.status || "idle"),
                            e("span", null, formatTime(item.updatedAt || item.createdAt)),
                          ),
                        ),
                    renaming
                      ? null
                      : e(
                          "button",
                          {
                            type: "button",
                            className: "session-rename-btn",
                            title: "重命名",
                            onClick: function (ev) {
                              ev.stopPropagation();
                              setEditingId(item.id);
                              setEditingName(sessionTitle(item));
                            },
                          },
                          "重命名",
                        ),
                  );
                }),
          ),
        ),
        e(
          "section",
          { className: "shell" },
          e(
            "div",
            { className: "toolbar" },
            e(
              "label",
              null,
              e("span", { className: "field-label" }, "Workspace"),
              e(Input, {
                value: cwd,
                placeholder: "/path/to/repo",
                onChange: function (ev) {
                  setCwd(ev.target.value);
                },
              }),
            ),
            e(
              "label",
              null,
              e("span", { className: "field-label" }, "Model"),
              e(Select, {
                style: { width: "100%" },
                value: model,
                options: models.map(function (m) {
                  return { value: m.id, label: m.name || m.id };
                }),
                onChange: setModel,
              }),
            ),
          ),
          e(
            "div",
            { className: "mcp-panel" },
            e(
              "button",
              {
                type: "button",
                className: "mcp-toggle",
                onClick: function () {
                  setMcpOpen(function (v) {
                    return !v;
                  });
                },
              },
              e("span", { className: "field-label" }, "MCP Servers"),
              e(
                "span",
                { className: "mcp-toggle-meta" },
                mcpError ? "JSON 有误" : mcpOpen ? "收起" : "配置",
              ),
            ),
            mcpOpen
              ? e(
                  "div",
                  { className: "mcp-body" },
                  e(
                    "p",
                    { className: "mcp-hint" },
                    "create / resume 时传入。每项需含 command（stdio）或 url（http/sse）。保存在本机 localStorage。",
                  ),
                  e("textarea", {
                    className: "mcp-json",
                    rows: 8,
                    spellCheck: false,
                    value: mcpJson,
                    placeholder:
                      '{\n  "my-mcp": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]\n  }\n}',
                    onChange: function (ev) {
                      setMcpJson(ev.target.value);
                      setMcpError("");
                    },
                    onBlur: function () {
                      try {
                        parseMcpServers();
                      } catch (_) {
                        /* shown via mcpError */
                      }
                    },
                  }),
                  mcpError
                    ? e("div", { className: "mcp-error" }, mcpError)
                    : e(
                        "div",
                        { className: "mcp-example" },
                        '示例：{ "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } }',
                      ),
                )
              : null,
          ),
          e(
            "div",
            { className: "meta-row" },
            e(
              "span",
              { className: "status" },
              e("span", { className: "status-dot" + (streaming ? " live" : "") }),
              streaming ? "streaming" : "idle",
            ),
            e("span", null, sessionId ? "session " + sessionId : "新会话 · 发送后创建"),
          ),
          e(
            "div",
            { className: "messages" },
            !hasThread
              ? e(
                  "div",
                  { className: "empty" },
                  e("strong", null, "在下方输入提示词开始"),
                  e("p", null, "也可从左侧选择已有会话继续。"),
                )
              : null,
            messages.map(function (msg) {
              const role =
                msg.role === "user"
                  ? "user"
                  : msg.role === "thinking"
                    ? "thinking"
                    : msg.role === "tool"
                      ? "tool"
                      : "assistant";
              const parts = messageParts(msg);
              if (role === "thinking" || role === "tool") {
                return e(
                  "article",
                  { key: msg.id, className: "msg msg-" + role },
                  e(
                    "div",
                    { className: "msg-body" },
                    parts.map(function (part, idx) {
                      if (part.kind === "thinking") {
                        return e(ThinkingCard, {
                          key: msg.id + "-th-" + idx,
                          text: part.text,
                          durationMs: part.durationMs,
                        });
                      }
                      if (part.kind === "tool") {
                        return e(ToolCard, {
                          key: msg.id + "-tool-" + idx,
                          tool: part.tool,
                        });
                      }
                      return null;
                    }),
                  ),
                );
              }
              return e(
                "article",
                {
                  key: msg.id,
                  className: "msg msg-" + role,
                },
                e("div", { className: "msg-role" }, roleLabel(role)),
                e(
                  "div",
                  { className: "msg-body" },
                  parts.map(function (part, idx) {
                    return e(
                      "div",
                      { key: msg.id + "-t-" + idx, className: "msg-content" },
                      renderMarkdown(part.text),
                    );
                  }),
                ),
              );
            }),
            liveText
              ? e(
                  "article",
                  { className: "msg msg-assistant is-streaming" },
                  e("div", { className: "msg-role" }, "Agent"),
                  e(
                    "div",
                    { className: "msg-body" },
                    e("div", { className: "msg-content" }, renderMarkdown(liveText)),
                  ),
                )
              : null,
            e("div", { ref: bottomRef }),
          ),
          e(
            "div",
            { className: "composer" },
            e(
              "div",
              { className: "composer-box" + (streaming ? " is-busy" : "") },
              e("textarea", {
                className: "composer-input",
                rows: 3,
                value: prompt,
                placeholder: streaming
                  ? "继续输入将作为 steer 注入…"
                  : "Plan, @ for context, / for commands",
                onChange: function (ev) {
                  setPrompt(ev.target.value);
                },
                onKeyDown: function (ev) {
                  if (ev.key === "Enter" && !ev.shiftKey) {
                    ev.preventDefault();
                    onSend();
                  }
                },
              }),
              e(
                "div",
                { className: "composer-toolbar" },
                e(
                  "span",
                  { className: "composer-hint" },
                  streaming
                    ? "Enter 发送为 steer · Shift+Enter 换行"
                    : "Enter 发送 · Shift+Enter 换行",
                ),
                e(
                  "button",
                  {
                    type: "button",
                    className: "composer-send",
                    title: streaming ? "Steer" : "发送",
                    disabled: !prompt.trim(),
                    onClick: onSend,
                  },
                  e(
                    "svg",
                    {
                      viewBox: "0 0 16 16",
                      width: 14,
                      height: 14,
                      "aria-hidden": "true",
                    },
                    e("path", {
                      d: "M8 3.2v9.6M8 3.2 4.4 6.8M8 3.2l3.6 3.6",
                      fill: "none",
                      stroke: "currentColor",
                      "stroke-width": 1.7,
                      "stroke-linecap": "round",
                      "stroke-linejoin": "round",
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(e(App));
})();
