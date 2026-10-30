/* global window */
(function (global) {
  function extractText(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (typeof node.text === "string") return node.text;
    if (typeof node.content === "string") return node.content;
    if (Array.isArray(node.content)) {
      return node.content
        .map(function (part) {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .join("");
    }
    if (node.message) return extractText(node.message);
    return "";
  }

  function assistantTextFromMessage(data) {
    if (!data) return "";
    if (typeof data.text === "string") return data.text;
    const direct = extractText(data.message);
    if (direct) return direct;
    const turn = data.message && data.message.agentConversationTurn;
    if (turn) {
      if (turn.assistantMessage) {
        const t = extractText(turn.assistantMessage);
        if (t) return t;
      }
      const steps = turn.steps || [];
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step && step.assistantMessage) {
          const t = extractText(step.assistantMessage);
          if (t) return t;
        }
      }
    }
    return "";
  }

  async function readSse(response, onEvent) {
    if (!response.ok) {
      const err = await response.json().catch(function () {
        return {};
      });
      throw new Error(err.error || response.statusText || "request failed");
    }
    if (!response.body) throw new Error("no response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let dataLines = [];

    function flush() {
      if (!dataLines.length) return;
      const raw = dataLines.join("\n");
      dataLines = [];
      let parsed = raw;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        /* keep string */
      }
      onEvent(eventName, parsed);
      eventName = "message";
    }

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === "") {
          flush();
        } else if (line.indexOf("event:") === 0) {
          eventName = line.slice(6).trim();
        } else if (line.indexOf("data:") === 0) {
          dataLines.push(line.slice(5).trim());
        }
      }
    }
    flush();
  }

  global.AgentHttpSse = {
    assistantTextFromMessage: assistantTextFromMessage,
    readSse: readSse,
  };
})(window);
