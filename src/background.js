import {
  AUTH_KEY,
  STORAGE_KEY,
  SYNC_KEY,
  assertSameOrigin,
  createActionGuard,
  encodeProjectId,
  flattenJenkinsJobs,
  isJenkinsAuthenticated,
  normalizeBaseUrl,
  normalizeCommitResponse,
  parseBuildParameters,
  safeMessage,
  serviceBaseFromLoginUrl,
} from "./shared.js";

const LOGIN_PENDING_KEY = "devFlowLoginPending";
const EXPLICIT_SERVICE_URLS_MIGRATION_KEY = "devFlowExplicitServiceUrlsRequired";
const runActionOnce = createActionGuard();
const serviceTabResolutions = new Map();
const automaticLoginAttempts = new Map();
const mergeRequestCommitCache = new Map();
const AUTOMATIC_LOGIN_COOLDOWN_MS = 120_000;

chrome.runtime.onInstalled.addListener(async (details) => {
  await restrictStorageAccess();
  await requireExplicitServiceUrls(details);
});
chrome.runtime.onStartup.addListener(restrictStorageAccess);

async function restrictStorageAccess() {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
}

async function requireExplicitServiceUrls(details) {
  const migration = await chrome.storage.local.get(EXPLICIT_SERVICE_URLS_MIGRATION_KEY);
  if (migration[EXPLICIT_SERVICE_URLS_MIGRATION_KEY]) return;

  if (details.reason === "update") {
    const storedSettings = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (storedSettings) {
      const previousOrigins = [storedSettings.gitlabLoginUrl, storedSettings.jenkinsLoginUrl]
        .map((url) => {
          try {
            return url ? permissionPattern(url) : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          ...storedSettings,
          gitlabLoginUrl: "",
          jenkinsLoginUrl: "",
        },
        [AUTH_KEY]: {},
      });
      await chrome.storage.local.remove(SYNC_KEY);
      if (previousOrigins.length) {
        await chrome.permissions.remove({ origins: [...new Set(previousOrigins)] });
      }
    }
  }

  await chrome.storage.local.set({ [EXPLICIT_SERVICE_URLS_MIGRATION_KEY]: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: safeMessage(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const pending = await getPendingLogin(tabId);
  if (!pending || !tab.url || new URL(tab.url).origin !== new URL(pending.loginUrl).origin) return;

  if (pending.phase === "ready") {
    await submitLoginForm(tabId, pending);
    return;
  }
  if (pending.phase === "submitted") await verifyPendingLogin(tabId, pending);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const pending = await getPendingLogin(tabId);
  if (!pending) {
    const auth = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] ?? {};
    for (const service of ["gitlab", "jenkins"]) {
      if (auth[service]?.tabId === tabId) await patchServiceAuth(service, { tabId: null, managedTab: false });
    }
    return;
  }
  await removePendingLogin(tabId);
  await updateServiceAuth(pending.service, {
    authenticated: false,
    pending: false,
    error: "Tab đăng nhập đã đóng trước khi xác thực thành công.",
  });
});

async function handleMessage(message) {
  switch (message?.type) {
    case "LOGIN_GITLAB":
      return beginLogin("gitlab", message.password);
    case "LOGIN_JENKINS":
      return beginLogin("jenkins", message.password);
    case "GET_AUTH_STATUS":
      return getAuthState();
    case "TEST_CONNECTIONS":
      return testConnections();
    case "SYNC_ALL":
      return syncAll(message.projectId);
    case "GET_PROJECTS":
      return gitlabRequest("/api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at");
    case "GET_BRANCHES":
      return gitlabRequest(`/api/v4/projects/${encodeProjectId(message.projectId)}/repository/branches?per_page=100`);
    case "GET_BRANCH_COMPARE":
      return getBranchComparison(message.projectId, message.sourceBranch, message.targetBranch);
    case "GET_MERGE_REQUESTS":
      return getMergeRequests(message.projectId);
    case "CREATE_MERGE_REQUEST":
      return createMergeRequest(message.payload);
    case "MERGE_MERGE_REQUEST":
      return mergeMergeRequest(message.projectId, message.mergeRequestIid);
    case "CLOSE_MERGE_REQUEST":
      return closeMergeRequest(message.projectId, message.mergeRequestIid);
    case "GET_JOBS":
      return getJenkinsJobs();
    case "GET_JENKINS_STAGE_VIEW":
      return getJenkinsStageView(message.jobUrl);
    case "TRIGGER_BUILD":
      return triggerBuild(message.jobUrl, message.parameters);
    default:
      throw new Error(`Yêu cầu ${message?.type || "không xác định"} không được hỗ trợ.`);
  }
}

async function getSettings() {
  const storedSettings = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!storedSettings) throw new Error("Chưa có cấu hình. Hãy mở Settings trước.");
  const { gitlabToken: _removedToken, ...settings } = storedSettings;
  if (Object.prototype.hasOwnProperty.call(storedSettings, "gitlabToken")) {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  }

  const normalized = {
    gitlabLoginUrl: normalizeBaseUrl(settings.gitlabLoginUrl),
    gitlabUsername: String(settings.gitlabUsername ?? "").trim(),
    gitlabPassword: String(settings.gitlabPassword ?? ""),
    jenkinsLoginUrl: normalizeBaseUrl(settings.jenkinsLoginUrl),
    jenkinsUsername: String(settings.jenkinsUsername ?? "").trim(),
    jenkinsPassword: String(settings.jenkinsPassword ?? ""),
  };
  normalized.gitlabUrl = serviceBaseFromLoginUrl(normalized.gitlabLoginUrl, "gitlab");
  normalized.jenkinsUrl = serviceBaseFromLoginUrl(normalized.jenkinsLoginUrl, "jenkins");
  return normalized;
}

async function getAuthState() {
  const auth = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] ?? {};
  const jenkins = auth.jenkins ?? { authenticated: false };
  return {
    gitlab: auth.gitlab ?? { authenticated: false },
    jenkins:
      jenkins.authenticated && !isJenkinsAuthenticated(jenkins)
        ? { ...jenkins, authenticated: false, error: "Chưa đăng nhập Jenkins." }
        : jenkins,
  };
}

async function updateServiceAuth(service, value) {
  const current = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] ?? {};
  await chrome.storage.local.set({ [AUTH_KEY]: { ...current, [service]: value } });
}

async function patchServiceAuth(service, patch) {
  const current = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] ?? {};
  await updateServiceAuth(service, { ...current[service], ...patch });
}

async function getPendingLogins() {
  return (await chrome.storage.session.get(LOGIN_PENDING_KEY))[LOGIN_PENDING_KEY] ?? {};
}

async function getPendingLogin(tabId) {
  return (await getPendingLogins())[String(tabId)];
}

async function setPendingLogin(tabId, value) {
  const all = await getPendingLogins();
  await chrome.storage.session.set({ [LOGIN_PENDING_KEY]: { ...all, [String(tabId)]: value } });
}

async function removePendingLogin(tabId) {
  const all = await getPendingLogins();
  delete all[String(tabId)];
  await chrome.storage.session.set({ [LOGIN_PENDING_KEY]: all });
}

async function beginLogin(service, passwordInput) {
  const settings = await getSettings();
  const username = service === "gitlab" ? settings.gitlabUsername : settings.jenkinsUsername;
  const storedPassword = service === "gitlab" ? settings.gitlabPassword : settings.jenkinsPassword;
  const password = String(passwordInput ?? storedPassword);
  const loginUrl = service === "gitlab" ? settings.gitlabLoginUrl : settings.jenkinsLoginUrl;
  const baseUrl = service === "gitlab" ? settings.gitlabUrl : settings.jenkinsUrl;
  if (!username) throw new Error(`Thiếu tài khoản ${service === "gitlab" ? "GitLab" : "Jenkins"}.`);
  if (!password || password.length > 1024) throw new Error("Mật khẩu không hợp lệ.");

  const auth = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] ?? {};
  let tab = null;
  let managedTab = false;
  if (auth[service]?.tabId) {
    try {
      const candidate = await chrome.tabs.get(auth[service].tabId);
      if (candidate.url && new URL(candidate.url).origin === new URL(loginUrl).origin) {
        tab = candidate;
        managedTab = Boolean(auth[service]?.managedTab);
      }
    } catch {
      // Reuse another service tab below when possible.
    }
  }
  if (!tab) {
    const origin = new URL(loginUrl).origin;
    const matches = await chrome.tabs.query({ url: `${origin}/*` });
    tab = matches.find((candidate) => candidate.id && candidate.url && new URL(candidate.url).origin === origin) ?? null;
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: "about:blank", active: false });
    managedTab = true;
  }
  if (tab.url && new URL(tab.url).origin === new URL(baseUrl).origin) {
    try {
      const identity = service === "gitlab"
        ? await requestInServiceTab("gitlab", tab.id, `${baseUrl}/api/v4/user`)
        : await requestInServiceTab("jenkins", tab.id, `${baseUrl}/whoAmI/api/json`);
      if (service === "jenkins" && !isJenkinsAuthenticated(identity)) throw new Error("Jenkins chưa xác thực session.");
      await updateServiceAuth(service, {
        authenticated: true,
        pending: false,
        username: identity.name || identity.username,
        baseUrl,
        tabId: tab.id,
        managedTab,
        verifiedAt: Date.now(),
        error: null,
      });
      return { opened: false, reused: true };
    } catch {
      // Navigate the existing service tab to the login form below.
    }
  }
  await setPendingLogin(tab.id, {
    service,
    username,
    password,
    loginUrl,
    baseUrl,
    managedTab,
    phase: "ready",
  });
  await updateServiceAuth(service, { authenticated: false, pending: true });
  await chrome.tabs.update(tab.id, { url: loginUrl });
  return { opened: true };
}

async function syncAll(requestedProjectId) {
  const startedAt = Date.now();
  const [gitlabLogin, jenkinsLogin] = await Promise.allSettled([
    ensureAuthenticated("gitlab"),
    ensureAuthenticated("jenkins"),
  ]);

  let projects = null;
  let branches = null;
  let mergeRequests = null;
  let jobs = null;
  let projectId = requestedProjectId;
  let gitlabError = gitlabLogin.status === "rejected" ? safeMessage(gitlabLogin.reason) : null;
  let jenkinsError = jenkinsLogin.status === "rejected" ? safeMessage(jenkinsLogin.reason) : null;

  if (!gitlabError) {
    try {
      projects = await gitlabRequest(
        "/api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at"
      );
      if (projectId && !projects.some((project) => String(project.id) === String(projectId))) {
        projectId = null;
      }
      if (projectId) {
        [branches, mergeRequests] = await Promise.all([
          gitlabRequest(`/api/v4/projects/${encodeProjectId(projectId)}/repository/branches?per_page=100`),
          getMergeRequests(projectId),
        ]);
      }
    } catch (error) {
      gitlabError = safeMessage(error);
    }
  }

  if (!jenkinsError) {
    try {
      jobs = await getJenkinsJobs();
    } catch (error) {
      jenkinsError = safeMessage(error);
    }
  }

  const result = {
    finishedAt: Date.now(),
    projectId,
    projects,
    branches,
    mergeRequests,
    jobs,
    gitlab: { ok: !gitlabError, error: gitlabError },
    jenkins: { ok: !jenkinsError, error: jenkinsError },
  };
  await chrome.storage.local.set({
    [SYNC_KEY]: {
      startedAt,
      finishedAt: result.finishedAt,
      gitlabOk: result.gitlab.ok,
      jenkinsOk: result.jenkins.ok,
      projectCount: projects?.length ?? 0,
      jobCount: jobs?.length ?? 0,
    },
  });
  return result;
}

async function ensureAuthenticated(service) {
  try {
    const identity = service === "gitlab" ? await getGitlabIdentity() : await getJenkinsIdentity();
    if (service === "jenkins" && !isJenkinsAuthenticated(identity)) {
      throw new Error("Jenkins chưa xác thực session.");
    }
    await patchServiceAuth(service, {
      authenticated: true,
      pending: false,
      username: identity.name || identity.username,
      verifiedAt: Date.now(),
      error: null,
    });
    return identity;
  } catch (error) {
    const startedAt = Date.now();
    const previousAttempt = automaticLoginAttempts.get(service) ?? 0;
    if (startedAt - previousAttempt < AUTOMATIC_LOGIN_COOLDOWN_MS) {
      const label = service === "gitlab" ? "GitLab" : "Jenkins";
      const message = `Phiên ${label} chưa hợp lệ. Extension sẽ không tự đăng nhập lặp lại liên tục; hãy bấm Đăng nhập nếu cần.`;
      await patchServiceAuth(service, { authenticated: false, pending: false, error: message });
      throw new Error(message);
    }
    automaticLoginAttempts.set(service, startedAt);
    await patchServiceAuth(service, { authenticated: false, pending: false, error: safeMessage(error) });
    await beginLogin(service);
    return waitForLogin(service, startedAt);
  }
}

async function waitForLogin(service, startedAt) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const auth = await getAuthState();
    const state = auth[service];
    if (state?.authenticated && state.verifiedAt >= startedAt) return state;
    if (!state?.pending && state?.error) throw new Error(state.error);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await cancelPendingLogin(service);
  const label = service === "gitlab" ? "GitLab" : "Jenkins";
  await patchServiceAuth(service, {
    authenticated: false,
    pending: false,
    error: `Đăng nhập ${label} chạy nền quá 20 giây hoặc cần thao tác bổ sung.`,
  });
  throw new Error(`Không thể tự đăng nhập ${label}.`);
}

async function cancelPendingLogin(service) {
  const all = await getPendingLogins();
  const entries = Object.entries(all).filter(([, pending]) => pending.service === service);
  for (const [tabId] of entries) {
    delete all[tabId];
    try {
      await chrome.tabs.remove(Number(tabId));
    } catch {
      // The login tab may already be closed.
    }
  }
  await chrome.storage.session.set({ [LOGIN_PENDING_KEY]: all });
}

async function submitLoginForm(tabId, pending) {
  if (await completeLoginFromExistingSession(tabId, pending)) return;

  await setPendingLogin(tabId, { ...pending, phase: "submitted" });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillAndSubmitLoginForm,
      args: [pending.service, pending.username, pending.password],
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || "Không tìm thấy form đăng nhập.");
    const current = await getPendingLogin(tabId);
    if (current) {
      const { password: _removed, ...withoutPassword } = current;
      await setPendingLogin(tabId, withoutPassword);
    }
  } catch (error) {
    await removePendingLogin(tabId);
    await updateServiceAuth(pending.service, {
      authenticated: false,
      pending: false,
      error: safeMessage(error),
    });
  }
}

async function completeLoginFromExistingSession(tabId, pending) {
  try {
    const identity = await getPendingLoginIdentity(tabId, pending);
    await completePendingLogin(tabId, pending, identity);
    return true;
  } catch {
    return false;
  }
}

function fillAndSubmitLoginForm(service, username, password) {
  const selectors =
    service === "gitlab"
      ? {
          username: 'input[name="user[login]"]',
          password: 'input[name="user[password]"]',
          remember: '#user_remember_me, input[type="checkbox"][name="user[remember_me]"]',
          form: 'form[data-testid="sign-in-form"]',
        }
      : {
          username: '#j_username, input[name="j_username"], input[name="username"], input[autocomplete="username"]',
          password: '#j_password, input[name="j_password"], input[name="password"], input[type="password"]',
          remember: '#remember_me, input[type="checkbox"][name="remember_me"]',
          form: 'form[name="login"]',
        };
  const usernameInput = document.querySelector(selectors.username);
  const passwordInput = document.querySelector(selectors.password);
  const form = document.querySelector(selectors.form) || passwordInput?.form || passwordInput?.closest("form");
  if (!usernameInput || !passwordInput || !form) {
    return { ok: false, error: "Cấu trúc trang đăng nhập không đúng như mong đợi." };
  }

  const setValue = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  setValue(usernameInput, username);
  setValue(passwordInput, password);
  const rememberInput = document.querySelector(selectors.remember);
  if (rememberInput && !rememberInput.checked) {
    rememberInput.click();
  }
  form.requestSubmit();
  return { ok: true };
}

async function verifyPendingLogin(tabId, pending) {
  try {
    const identity = await getPendingLoginIdentity(tabId, pending);
    await completePendingLogin(tabId, pending, identity);
  } catch {
    await updateServiceAuth(pending.service, {
      authenticated: false,
      pending: true,
      error: "Chưa xác thực thành công. Hãy kiểm tra thông báo trên trang đăng nhập hoặc hoàn tất 2FA.",
    });
  }
}

async function getPendingLoginIdentity(tabId, pending) {
  if (await hasLoginFormInTab(tabId, pending.service)) {
    throw new Error(`${pending.service === "gitlab" ? "GitLab" : "Jenkins"} vẫn đang hiển thị form đăng nhập.`);
  }
  const identity =
    pending.service === "gitlab"
      ? await requestInServiceTab("gitlab", tabId, `${pending.baseUrl}/api/v4/user`)
      : await requestInServiceTab("jenkins", tabId, `${pending.baseUrl}/whoAmI/api/json`);
  if (pending.service === "jenkins" && !isJenkinsAuthenticated(identity)) {
    throw new Error("Jenkins chưa xác thực session.");
  }
  return identity;
}

async function hasLoginFormInTab(tabId, service) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageHasLoginForm,
    args: [service],
  });
  return Boolean(results[0]?.result);
}

function pageHasLoginForm(service) {
  const usernameSelector =
    service === "gitlab"
      ? 'input[name="user[login]"]'
      : '#j_username, input[name="j_username"], input[name="username"], input[autocomplete="username"]';
  const passwordSelector =
    service === "gitlab"
      ? 'input[name="user[password]"]'
      : '#j_password, input[name="j_password"], input[name="password"], input[type="password"]';
  return Boolean(document.querySelector(usernameSelector) && document.querySelector(passwordSelector));
}

async function completePendingLogin(tabId, pending, identity) {
  await updateServiceAuth(pending.service, {
    authenticated: true,
    pending: false,
    username: identity.name || identity.username,
    baseUrl: pending.baseUrl,
    tabId,
    managedTab: Boolean(pending.managedTab),
    verifiedAt: Date.now(),
  });
  await removePendingLogin(tabId);
}

async function testConnections() {
  const results = await Promise.allSettled([getGitlabIdentity(), getJenkinsIdentity()]);
  const gitlabIdentity = results[0].status === "fulfilled" ? results[0].value : null;
  const jenkinsIdentity = results[1].status === "fulfilled" ? results[1].value : null;
  const jenkinsAuthenticated = isJenkinsAuthenticated(jenkinsIdentity);
  if (gitlabIdentity) {
    await patchServiceAuth("gitlab", {
      authenticated: true,
      pending: false,
      username: gitlabIdentity.name || gitlabIdentity.username,
      verifiedAt: Date.now(),
    });
  }
  if (jenkinsAuthenticated) {
    await patchServiceAuth("jenkins", {
      authenticated: true,
      pending: false,
      username: jenkinsIdentity.name,
      verifiedAt: Date.now(),
    });
  } else {
    await patchServiceAuth("jenkins", {
      authenticated: false,
      pending: false,
      error: results[1].status === "rejected" ? safeMessage(results[1].reason) : "Chưa đăng nhập Jenkins.",
    });
  }
  return {
    gitlab: gitlabIdentity
      ? { ok: true, label: gitlabIdentity.name || gitlabIdentity.username }
      : { ok: false, error: safeMessage(results[0].reason) },
    jenkins: jenkinsAuthenticated
      ? { ok: true, label: jenkinsIdentity.name || "Jenkins" }
      : {
          ok: false,
          error: results[1].status === "rejected" ? safeMessage(results[1].reason) : "Chưa đăng nhập Jenkins.",
        },
  };
}

async function gitlabSessionRequest(path, options = {}, baseUrlOverride) {
  const settings = await getSettings();
  const baseUrl = baseUrlOverride ?? settings.gitlabUrl;
  const url = `${baseUrl}${path}`;
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };
  try {
    return await serviceSessionRequest("gitlab", url, { ...options, headers });
  } catch (error) {
    if (error?.status === 401) throw apiStatusError("Phiên đăng nhập GitLab đã hết hạn hoặc không hợp lệ.", 401);
    throw error;
  }
}

async function getGitlabIdentity() {
  try {
    const identity = await gitlabSessionRequest("/api/v4/user");
    await patchServiceAuth("gitlab", {
      authenticated: true,
      pending: false,
      username: identity.name || identity.username,
      verifiedAt: Date.now(),
      error: null,
    });
    return identity;
  } catch (error) {
    await patchServiceAuth("gitlab", {
      authenticated: false,
      pending: false,
      error: safeMessage(error),
    });
    throw error;
  }
}

function apiStatusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function gitlabRequest(path, options = {}) {
  await getGitlabIdentity();
  return gitlabSessionRequest(path, options);
}

async function getMergeRequests(projectId) {
  if (!projectId) throw new Error("Thiếu project để tải merge request.");
  const mergeRequests = await gitlabRequest(
    `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=20`
  );
  return mapWithConcurrency(mergeRequests, 4, async (mergeRequest) => {
    const cacheKey = `${projectId}:${mergeRequest.iid}`;
    const version = mergeRequest.sha || mergeRequest.updated_at || "";
    const cached = mergeRequestCommitCache.get(cacheKey);
    if (cached?.version === version && cached.commits.length) return { ...mergeRequest, commits: cached.commits };
    try {
      const commits = await loadMergeRequestCommits(projectId, mergeRequest);
      if (commits.length) {
        mergeRequestCommitCache.set(cacheKey, { version, commits });
        while (mergeRequestCommitCache.size > 200) {
          mergeRequestCommitCache.delete(mergeRequestCommitCache.keys().next().value);
        }
      } else {
        mergeRequestCommitCache.delete(cacheKey);
      }
      return { ...mergeRequest, commits };
    } catch (error) {
      return { ...mergeRequest, commits: [], commitsError: safeMessage(error) };
    }
  });
}

async function loadMergeRequestCommits(projectId, mergeRequest) {
  let commits = [];
  let commitsError = null;
  try {
    const response = await gitlabSessionRequest(
      `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${encodeURIComponent(String(mergeRequest.iid))}/commits`
    );
    commits = normalizeCommitResponse(response);
  } catch (error) {
    commitsError = error;
  }

  if (!commits.length && mergeRequest.source_branch && mergeRequest.target_branch) {
    try {
      const query = new URLSearchParams({
        from: mergeRequest.target_branch,
        to: mergeRequest.source_branch,
      });
      const comparison = await gitlabSessionRequest(
        `/api/v4/projects/${encodeProjectId(projectId)}/repository/compare?${query.toString()}`
      );
      commits = normalizeCommitResponse(comparison);
    } catch (comparisonError) {
      throw commitsError || comparisonError;
    }
  }
  if (!commits.length && commitsError) throw commitsError;
  return commits;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getBranchComparison(projectId, sourceBranch, targetBranch) {
  if (!projectId || !sourceBranch || !targetBranch) throw new Error("Thiếu project hoặc branch để compare.");
  const query = new URLSearchParams({ from: targetBranch, to: sourceBranch });
  return gitlabRequest(
    `/api/v4/projects/${encodeProjectId(projectId)}/repository/compare?${query.toString()}`
  );
}

async function createMergeRequest(payload) {
  if (!payload?.projectId || !payload.sourceBranch || !payload.targetBranch || !payload.title?.trim()) {
    throw new Error("Project, source branch, target branch và title là bắt buộc.");
  }
  if (payload.sourceBranch === payload.targetBranch) {
    throw new Error("Source branch và target branch phải khác nhau.");
  }
  const actionKey = `create-mr:${payload.projectId}:${payload.sourceBranch}:${payload.targetBranch}:${payload.title.trim()}`;
  return runActionOnce(actionKey, 3_000, "Merge request này vừa được gửi. Hãy chờ GitLab xử lý.", () =>
    gitlabRequest(`/api/v4/projects/${encodeProjectId(payload.projectId)}/merge_requests`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: payload.sourceBranch,
        target_branch: payload.targetBranch,
        title: payload.title.trim(),
        description: String(payload.description ?? "").trim(),
        remove_source_branch: Boolean(payload.removeSourceBranch),
        squash: Boolean(payload.squash),
      }),
    })
  );
}

async function mergeMergeRequest(projectId, mergeRequestIid) {
  if (!projectId || !mergeRequestIid) throw new Error("Thiếu merge request cần merge.");
  const actionKey = `merge-mr:${projectId}:${mergeRequestIid}`;
  return runActionOnce(actionKey, 3_000, "Merge request này đang được merge.", () =>
    gitlabRequest(
      `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${encodeURIComponent(String(mergeRequestIid))}/merge`,
      { method: "PUT" }
    )
  );
}

async function closeMergeRequest(projectId, mergeRequestIid) {
  if (!projectId || !mergeRequestIid) throw new Error("Thiếu merge request cần đóng.");
  const actionKey = `close-mr:${projectId}:${mergeRequestIid}`;
  return runActionOnce(actionKey, 3_000, "Merge request này đang được đóng.", () =>
    gitlabRequest(
      `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${encodeURIComponent(String(mergeRequestIid))}`,
      { method: "PUT", body: JSON.stringify({ state_event: "close" }) }
    )
  );
}

async function jenkinsSessionRequest(path, options = {}, baseUrlOverride) {
  const settings = baseUrlOverride ? null : await getSettings();
  const baseUrl = baseUrlOverride ?? settings.jenkinsUrl;
  return serviceSessionRequest("jenkins", `${baseUrl}${path}`, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
}

async function getJenkinsIdentity() {
  return jenkinsSessionRequest("/whoAmI/api/json");
}

async function requireJenkinsAuth() {
  const identity = await getJenkinsIdentity();
  if (!isJenkinsAuthenticated(identity)) throw new Error("Phiên Jenkins chưa đăng nhập hoặc đã hết hạn.");
  return identity;
}

async function getJenkinsJobs() {
  await requireJenkinsAuth();
  const fields = "name,url,color,_class,lastBuild[number,result,url,timestamp]";
  let tree = fields;
  for (let depth = 1; depth < 8; depth += 1) tree = `${fields},jobs[${tree}]`;
  const data = await jenkinsSessionRequest(`/api/json?tree=jobs[${tree}]`);
  return flattenJenkinsJobs(data.jobs);
}

async function getJenkinsStageView(jobUrl) {
  await requireJenkinsAuth();
  const settings = await getSettings();
  const trustedJobUrl = assertSameOrigin(jobUrl, settings.jenkinsUrl).replace(/\/+$/, "");
  const runs = await serviceSessionRequest(
    "jenkins",
    `${trustedJobUrl}/wfapi/runs?fullStages=true`,
    { headers: { Accept: "application/json" } }
  );
  if (!Array.isArray(runs)) throw new Error("Jenkins không trả về danh sách Pipeline runs hợp lệ.");
  return runs.slice(0, 5);
}

async function getJenkinsCrumb() {
  try {
    return await jenkinsSessionRequest("/crumbIssuer/api/json");
  } catch (error) {
    if (/\b404\b/.test(safeMessage(error))) return null;
    throw error;
  }
}

async function triggerBuild(jobUrl, parametersText) {
  return runActionOnce(`build:${jobUrl}`, 3_000, "Build này vừa được đưa vào queue. Hãy chờ Jenkins xử lý.", async () => {
    await requireJenkinsAuth();
    const settings = await getSettings();
    const trustedJobUrl = assertSameOrigin(jobUrl, settings.jenkinsUrl).replace(/\/+$/, "");
    const parameters = parseBuildParameters(parametersText);
    const hasParameters = [...parameters.keys()].length > 0;
    const endpoint = `${trustedJobUrl}/${hasParameters ? "buildWithParameters" : "build"}?delay=0sec`;
    const crumb = await getJenkinsCrumb();
    const headers = {};
    if (crumb?.crumbRequestField && crumb?.crumb) headers[crumb.crumbRequestField] = crumb.crumb;
    if (hasParameters) headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";

    const result = await serviceSessionRequest("jenkins", endpoint, {
      method: "POST",
      headers,
      body: hasParameters ? parameters.toString() : undefined,
      returnMetadata: true,
    });
    return { queued: true, queueUrl: result.location };
  });
}

async function serviceSessionRequest(service, url, options = {}) {
  const { returnMetadata = false, ...requestOptions } = options;
  const tabId = await resolveServiceTab(service, url);
  return requestInServiceTab(service, tabId, url, requestOptions, returnMetadata);
}

async function resolveServiceTab(service, url) {
  const resolving = serviceTabResolutions.get(service);
  if (resolving) return resolving;
  const promise = resolveServiceTabInternal(service, url);
  serviceTabResolutions.set(service, promise);
  try {
    return await promise;
  } finally {
    if (serviceTabResolutions.get(service) === promise) serviceTabResolutions.delete(service);
  }
}

async function resolveServiceTabInternal(service, url) {
  const origin = new URL(url).origin;
  const auth = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] ?? {};
  const rememberedTabId = auth[service]?.tabId;
  if (rememberedTabId) {
    try {
      const tab = await chrome.tabs.get(rememberedTabId);
      if (tab.url && new URL(tab.url).origin === origin) return rememberedTabId;
    } catch {
      // The remembered login tab was closed.
    }
  }

  const matches = await chrome.tabs.query({ url: `${origin}/*` });
  const existing = matches.find((tab) => tab.id && tab.url && new URL(tab.url).origin === origin);
  if (existing?.id) {
    await patchServiceAuth(service, { tabId: existing.id, managedTab: false });
    return existing.id;
  }

  const tab = await chrome.tabs.create({ url: origin, active: false });
  await waitForTabComplete(tab.id);
  await patchServiceAuth(service, { tabId: tab.id, managedTab: true });
  return tab.id;
}

async function waitForTabComplete(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Hết thời gian chờ tab hệ thống tải xong."));
    }, 15_000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function requestInServiceTab(service, tabId, url, options = {}, returnMetadata = false) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || new URL(tab.url).origin !== new URL(url).origin) {
    throw new Error(`Tab ${service === "gitlab" ? "GitLab" : "Jenkins"} không cùng host với API.`);
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: performSameOriginRequest,
    args: [service, url, options],
  });
  const response = results[0]?.result;
  if (!response) throw new Error("Không nhận được kết quả API từ tab hệ thống.");
  if (response.networkError) throw new Error(response.networkError);
  const data = parseInjectedResponse(response, service === "gitlab" ? "GitLab" : "Jenkins");
  return returnMetadata ? { data, location: response.location } : data;
}

async function performSameOriginRequest(service, url, options) {
  try {
    const requestOptions = { ...options };
    const headers = new Headers(options.headers ?? {});
    const method = String(options.method ?? "GET").toUpperCase();
    const needsCsrfToken = service === "gitlab" && !["GET", "HEAD", "OPTIONS"].includes(method);

    if (needsCsrfToken) {
      let csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
      if (!csrfToken) {
        try {
          const requestUrl = new URL(url);
          const apiPathIndex = requestUrl.pathname.indexOf("/api/v4/");
          const applicationPath = apiPathIndex >= 0 ? requestUrl.pathname.slice(0, apiPathIndex + 1) : "/";
          const pageResponse = await fetch(`${requestUrl.origin}${applicationPath}`, {
            credentials: "include",
            headers: { Accept: "text/html" },
          });
          if (pageResponse.ok) {
            const page = new DOMParser().parseFromString(await pageResponse.text(), "text/html");
            csrfToken = page.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
          }
        } catch {
          // Let the API request return its own authentication error below.
        }
      }
      if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
      headers.set("X-Requested-With", "XMLHttpRequest");
    }

    requestOptions.headers = Object.fromEntries(headers.entries());
    const response = await fetch(url, { ...requestOptions, credentials: "include" });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
      location: response.headers.get("Location"),
    };
  } catch (error) {
    return { networkError: error instanceof Error ? error.message : String(error) };
  }
}

function parseInjectedResponse(response, service) {
  if (response.ok) {
    if (!response.text) return null;
    try {
      return JSON.parse(response.text);
    } catch {
      throw new Error(`${service} trả về dữ liệu không hợp lệ. Có thể phiên đăng nhập đã hết hạn.`);
    }
  }

  let detail = response.text;
  try {
    const parsed = JSON.parse(response.text);
    detail = parsed.message || parsed.error || parsed.errors || response.text;
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    // Keep the response body as-is when it is not JSON.
  }
  const concise = String(detail).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  throw apiStatusError(`${service} trả về ${response.status}${concise ? `: ${concise}` : ""}`, response.status);
}
