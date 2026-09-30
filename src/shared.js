export const STORAGE_KEY = "devFlowSettings";
export const AUTH_KEY = "devFlowAuth";
export const SYNC_KEY = "devFlowLastSync";

export function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL không hợp lệ. Hãy nhập đầy đủ http:// hoặc https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("URL phải dùng http hoặc https.");
  }
  if (url.username || url.password) {
    throw new Error("Không nhúng username hoặc password vào URL.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function permissionPattern(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return `${url.origin}/*`;
}

export function encodeProjectId(id) {
  return encodeURIComponent(String(id));
}

export function parseBuildParameters(text) {
  const params = new URLSearchParams();
  const lines = String(text ?? "").split(/\r?\n/);

  for (const [index, originalLine] of lines.entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Dòng ${index + 1} phải có định dạng KEY=VALUE.`);
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) throw new Error(`Dòng ${index + 1} thiếu tên parameter.`);
    params.append(key, value);
  }

  return params;
}

export function serviceBaseFromLoginUrl(loginUrl, service) {
  const serviceLabel = service === "gitlab" ? "GitLab" : "Jenkins";
  const normalizedUrl = normalizeBaseUrl(loginUrl);
  if (!normalizedUrl) throw new Error(`Hãy nhập ${serviceLabel} login URL.`);
  const url = new URL(normalizedUrl);
  const suffix = service === "gitlab" ? /\/users\/sign_in$/ : /\/login$/;
  if (!suffix.test(url.pathname)) {
    throw new Error(
      service === "gitlab"
        ? "GitLab login URL phải kết thúc bằng /users/sign_in."
        : "Jenkins login URL phải kết thúc bằng /login."
    );
  }
  url.pathname = url.pathname.replace(suffix, "");
  return url.toString().replace(/\/$/, "");
}

export function assertSameOrigin(candidate, baseUrl) {
  const candidateUrl = new URL(candidate);
  const base = new URL(normalizeBaseUrl(baseUrl));
  if (candidateUrl.origin !== base.origin) {
    throw new Error("Jenkins trả về job URL thuộc host không được tin cậy.");
  }
  return candidateUrl.toString();
}

export function isJenkinsAuthenticated(identity) {
  const username = String(identity?.name ?? identity?.username ?? "").trim().toLowerCase();
  return identity?.authenticated === true && username !== "anonymous";
}

export function createActionGuard() {
  const recentActions = new Map();
  return async function runActionOnce(key, cooldownMs, duplicateMessage, action) {
    const now = Date.now();
    for (const [storedKey, stored] of recentActions) {
      if (!stored.pending && now - stored.completedAt >= 60_000) recentActions.delete(storedKey);
    }
    const existing = recentActions.get(key);
    if (existing?.pending || now - (existing?.completedAt ?? 0) < cooldownMs) {
      throw new Error(duplicateMessage);
    }

    const state = { pending: true, completedAt: 0 };
    recentActions.set(key, state);
    try {
      const result = await action();
      state.pending = false;
      state.completedAt = Date.now();
      return result;
    } catch (error) {
      recentActions.delete(key);
      throw error;
    }
  };
}

export function normalizeCommitResponse(response) {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.commits) ? response.commits : [];
}

export function flattenJenkinsJobs(items, parentNames = []) {
  const flattened = [];
  for (const item of items ?? []) {
    if (!item?.name || !item?.url) continue;
    const names = [...parentNames, item.name];
    const children = Array.isArray(item.jobs) ? item.jobs : [];
    const isContainer = children.length > 0 || /folder|multibranchproject/i.test(String(item._class ?? ""));
    if (isContainer) {
      flattened.push(...flattenJenkinsJobs(children, names));
    } else {
      flattened.push({ ...item, path: names.join("/job/") });
    }
  }
  return flattened.sort((left, right) => left.path.localeCompare(right.path));
}

export function searchMatchScore(label, query) {
  const normalize = (value) => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const text = normalize(label);
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) {
      score += tokens.includes(term) ? 30 : 20;
      continue;
    }
    const fuzzyPrefix = term.slice(0, Math.max(2, term.length - 1));
    if (fuzzyPrefix.length >= 2 && tokens.some((token) => token.startsWith(fuzzyPrefix))) {
      score += 5;
      continue;
    }
    return -1;
  }
  return score;
}

export function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
