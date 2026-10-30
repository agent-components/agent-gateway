/* global window */
(function (global) {
  let token = "";

  function setToken(value) {
    token = value || "";
  }

  function authHeaders() {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }

  async function fetchUiConfig() {
    const res = await fetch("/api/v1/ui-config");
    if (!res.ok) throw new Error("failed to load ui config");
    return res.json();
  }

  async function listModels() {
    const res = await fetch("/api/v1/models");
    const data = await res.json();
    return data.items || [];
  }

  async function listSessions(cwd, limit) {
    const q = new URLSearchParams();
    if (cwd) q.set("cwd", cwd);
    if (limit) q.set("limit", String(limit));
    const res = await fetch("/api/v1/sessions?" + q.toString());
    if (!res.ok) throw new Error("failed to list sessions");
    return res.json();
  }

  async function getSession(id, cwd) {
    const res = await fetch(
      "/api/v1/sessions/" + encodeURIComponent(id) + "?cwd=" + encodeURIComponent(cwd),
    );
    if (!res.ok) throw new Error("failed to load session");
    return res.json();
  }

  function chatCreate(body, signal) {
    return fetch("/api/v1/chat/create", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: signal,
    });
  }

  function chatResume(body, signal) {
    return fetch("/api/v1/chat/resume", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: signal,
    });
  }

  function chatCancel(body) {
    return fetch("/api/v1/chat/cancel", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
  }

  function chatSteer(body) {
    return fetch("/api/v1/chat/steer", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    }).then(async function (res) {
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.message || data.error || res.statusText);
      return data;
    });
  }

  function chatConnect(body, signal) {
    return fetch("/api/v1/chat/connect", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: signal,
    });
  }

  function renameSession(id, body) {
    return fetch("/api/v1/sessions/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(body),
    }).then(async function (res) {
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.message || data.error || res.statusText);
      return data;
    });
  }

  global.AgentHttpApi = {
    setToken: setToken,
    fetchUiConfig: fetchUiConfig,
    listModels: listModels,
    listSessions: listSessions,
    getSession: getSession,
    renameSession: renameSession,
    chatCreate: chatCreate,
    chatResume: chatResume,
    chatConnect: chatConnect,
    chatSteer: chatSteer,
    chatCancel: chatCancel,
  };
})(window);
