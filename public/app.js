/* global React, ReactDOM, antd, AgentHttpApi, AgentHttpSse */
(function () {
  const e = React.createElement;
  const { useEffect, useRef, useState } = React;
  const { Button, Input, Select, Space, Typography, message } = antd;

  function bubbleText(msg) {
    if (typeof msg.content === "string") return msg.content;
    if (msg.content && typeof msg.content.text === "string") return msg.content.text;
    try {
      return JSON.stringify(msg.content, null, 2);
    } catch (_) {
      return String(msg.content ?? "");
    }
  }

  function App() {
    const [cwd, setCwd] = useState("");
    const [model, setModel] = useState("composer-2.5");
    const [models, setModels] = useState([{ id: "composer-2.5" }]);
    const [sessionId, setSessionId] = useState(null);
    const [prompt, setPrompt] = useState("");
    const [messages, setMessages] = useState([]);
    const [streaming, setStreaming] = useState(false);
    const [liveText, setLiveText] = useState("");
    const abortRef = useRef(null);
    const bottomRef = useRef(null);

    useEffect(function () {
      AgentHttpApi.fetchUiConfig()
        .then(function (cfg) {
          AgentHttpApi.setToken(cfg.token);
          setCwd(cfg.defaultCwd || "");
          return AgentHttpApi.listModels();
        })
        .then(function (items) {
          if (items && items.length) {
            setModels(items);
            setModel(items[0].id);
          }
        })
        .catch(function (err) {
          message.error(err.message || String(err));
        });
    }, []);

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
      setMessages(
        (detail.messages || []).map(function (m) {
          return { id: m.id, role: m.role, content: m.content };
        }),
      );
    }

    async function onSend() {
      const text = prompt.trim();
      if (!text || streaming) return;
      if (!cwd.trim()) {
        message.warning("请填写 cwd");
        return;
      }

      setPrompt("");
      setMessages(function (prev) {
        return prev.concat([{ id: "local-" + Date.now(), role: "user", content: text }]);
      });
      setLiveText("");
      setStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = sessionId
          ? await AgentHttpApi.chatResume(
              { sessionId: sessionId, prompt: text, model: model, cwd: cwd },
              ac.signal,
            )
          : await AgentHttpApi.chatCreate(
              { prompt: text, model: model, cwd: cwd },
              ac.signal,
            );

        let currentSession = sessionId;
        let assistant = "";

        await AgentHttpSse.readSse(res, function (eventName, data) {
          if (eventName === "message") {
            if (data && data.sessionId) currentSession = data.sessionId;
            if (data && data.type === "assistant") {
              const chunk = AgentHttpSse.assistantTextFromMessage(data);
              if (chunk) {
                assistant = chunk.length >= assistant.length ? chunk : assistant + chunk;
                setLiveText(assistant);
              }
            }
          }
          if (eventName === "result" && data && data.sessionId) {
            currentSession = data.sessionId;
          }
          if (eventName === "done") {
            /* noop */
          }
          if (eventName === "error") {
            message.error((data && data.message) || "stream error");
          }
        });

        if (currentSession) {
          setSessionId(currentSession);
          await reloadSession(currentSession, cwd);
        } else if (assistant) {
          setMessages(function (prev) {
            return prev.concat([
              { id: "assistant-" + Date.now(), role: "assistant", content: assistant },
            ]);
          });
        }
        setLiveText("");
      } catch (err) {
        if (err && err.name !== "AbortError") {
          message.error(err.message || String(err));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    }

    async function onCancel() {
      if (abortRef.current) abortRef.current.abort();
      if (sessionId) {
        try {
          await AgentHttpApi.chatCancel({ sessionId: sessionId });
        } catch (_) {
          /* ignore */
        }
      }
      setStreaming(false);
    }

    function onNewChat() {
      if (streaming) onCancel();
      setSessionId(null);
      setMessages([]);
      setLiveText("");
    }

    return e(
      "div",
      { className: "app" },
      e(
        "div",
        { className: "toolbar" },
        e(Input, {
          style: { flex: 1, minWidth: 180 },
          value: cwd,
          placeholder: "cwd",
          onChange: function (ev) {
            setCwd(ev.target.value);
          },
        }),
        e(Select, {
          style: { width: 200 },
          value: model,
          options: models.map(function (m) {
            return { value: m.id, label: m.name || m.id };
          }),
          onChange: setModel,
        }),
        e(
          Space,
          null,
          e(Button, { onClick: onNewChat }, "新会话"),
          streaming
            ? e(
                Button,
                { danger: true, onClick: onCancel },
                "停止",
              )
            : null,
        ),
      ),
      e(
        "div",
        { className: "meta" },
        sessionId ? "session: " + sessionId : "新会话（发送后创建）",
      ),
      e(
        "div",
        { className: "messages" },
        messages.map(function (msg) {
          return e(
            "div",
            { key: msg.id, className: "bubble " + (msg.role === "user" ? "user" : "assistant") },
            e("div", { className: "role" }, msg.role),
            bubbleText(msg),
          );
        }),
        liveText
          ? e(
              "div",
              { className: "bubble assistant" },
              e("div", { className: "role" }, "assistant"),
              liveText,
            )
          : null,
        e("div", { ref: bottomRef }),
      ),
      e(
        "div",
        { className: "composer" },
        e(Input.TextArea, {
          rows: 3,
          value: prompt,
          placeholder: "输入提示词，Enter 发送（Shift+Enter 换行）",
          onChange: function (ev) {
            setPrompt(ev.target.value);
          },
          onPressEnter: function (ev) {
            if (!ev.shiftKey) {
              ev.preventDefault();
              onSend();
            }
          },
        }),
        e(
          Button,
          {
            type: "primary",
            disabled: streaming || !prompt.trim(),
            onClick: onSend,
            style: { alignSelf: "flex-end" },
          },
          "发送",
        ),
      ),
    );
  }

  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(e(App));
})();
