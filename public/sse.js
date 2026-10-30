/* global window */
(function (global) {
  function assistantTextFromMessage(data) {
    if (!data) return "";
    if (typeof data.text === "string") return data.text;
    const msg = data.message;
    if (!msg) return "";
    if (typeof msg === "string") return msg;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map(function (part) {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .join("");
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
