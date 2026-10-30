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

  global.AgentHttpApi = {
    setToken: setToken,
    fetchUiConfig: fetchUiConfig,
    listModels: listModels,
    getSession: getSession,
    chatCreate: chatCreate,
    chatResume: chatResume,
    chatCancel: chatCancel,
  };
})(window);
