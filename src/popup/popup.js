import {
  AUTH_KEY,
  STORAGE_KEY,
  SYNC_KEY,
  UI_STATE_KEY,
  normalizeBaseUrl,
  permissionPattern,
  safeMessage,
  searchMatchScore,
  serviceBaseFromLoginUrl,
} from "../shared.js";

const status = document.querySelector("#status");
const projectSelect = document.querySelector("#project");
const sourceSelect = document.querySelector("#source-branch");
const targetSelect = document.querySelector("#target-branch");
const mergeRequestTitle = document.querySelector("#mr-title");
const jobSelect = document.querySelector("#job");
const stageView = document.querySelector("#stage-view");
const stageViewContent = document.querySelector("#stage-view-content");
const projectOptions = document.querySelector("#project-options");
const sourceOptions = document.querySelector("#source-branch-options");
const targetOptions = document.querySelector("#target-branch-options");
const jobOptions = document.querySelector("#job-options");
const mergeRequestList = document.querySelector("#merge-request-list");
const mergeRequestCount = document.querySelector("#merge-request-count");
const branchCompare = document.querySelector("#branch-compare");
const branchCompareList = document.querySelector("#branch-compare-list");
const branchCompareCount = document.querySelector("#branch-compare-count");
let projects = [];
let branches = [];
let jobs = [];
let mergeRequests = [];
let lastAutomaticMergeRequestTitle = "";
let branchCompareRequestId = 0;
let stageViewRequestId = 0;
let stagePollId = 0;
let stagePollJobUrl = "";
let latestStageRuns = [];
let latestStageJobUrl = "";
let stageViewDom = null;
let trackedBuild = null;
let autoSyncInProgress = false;
let lastPersistedUiState = {};
let settingsWritePromise = Promise.resolve();
const activeLoginServices = new Set();
const searchSelectData = new Map();
const persistedControlIds = [
  "mr-title",
  "mr-description",
  "squash",
  "remove-source",
];
const settingControlIds = [
  "gitlab-login-url",
  "gitlab-username",
  "gitlab-password",
  "jenkins-login-url",
  "jenkins-username",
  "jenkins-password",
];

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    activateTab(button.dataset.tab);
    persistUiState();
  });
});
const SEARCH_SELECT_CHANGE_EVENT = "search-select-change";

projectSelect.addEventListener(SEARCH_SELECT_CHANGE_EVENT, loadBranches);
projectSelect.addEventListener("input", () => {
  clearBranches();
  clearMergeRequests();
});
jobSelect.addEventListener(SEARCH_SELECT_CHANGE_EVENT, updateSelectedJob);
jobSelect.addEventListener("input", hideStageView);
[sourceSelect, targetSelect].forEach((input) => {
  input.addEventListener(SEARCH_SELECT_CHANGE_EVENT, () => {
    updateDefaultMergeRequestTitle();
    loadBranchComparison();
  });
  input.addEventListener("input", () => {
    updateDefaultMergeRequestTitle();
    if (!selectedBranchPair()) clearBranchComparison();
  });
});
mergeRequestTitle.addEventListener("input", () => {
  if (!mergeRequestTitle.value.trim()) updateDefaultMergeRequestTitle();
});
mergeRequestList.addEventListener("click", handleMergeRequestAction);
[projectSelect, sourceSelect, targetSelect, jobSelect].forEach(setupSearchSelect);
[projectSelect, sourceSelect, targetSelect, jobSelect].forEach((input) => {
  input.addEventListener("input", persistUiState);
  input.addEventListener(SEARCH_SELECT_CHANGE_EVENT, persistUiState);
});
persistedControlIds.forEach((id) => {
  document.querySelector(`#${id}`).addEventListener("input", persistUiState);
});
settingControlIds.forEach((id) => {
  document.querySelector(`#${id}`).addEventListener("input", persistSettings);
});
window.addEventListener("pagehide", () => {
  persistUiState();
  persistSettings();
});
document.querySelector("#create-mr").addEventListener("click", createMergeRequest);
document.querySelector("#trigger-build").addEventListener("click", triggerBuild);
document.querySelector("#test-connections").addEventListener("click", testConnections);
document.querySelector("#login-gitlab").addEventListener("click", () => login("gitlab"));
document.querySelector("#login-jenkins").addEventListener("click", () => login("jenkins"));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[AUTH_KEY]) {
    refreshAuthStatus();
    handleAuthenticationChange(changes[AUTH_KEY].newValue);
    const previousAuth = changes[AUTH_KEY].oldValue ?? {};
    const currentAuth = changes[AUTH_KEY].newValue ?? {};
    const becameAuthenticated = Object.entries(currentAuth).some(
      ([service, state]) => state?.authenticated && !previousAuth[service]?.authenticated
    );
    if (becameAuthenticated) {
      runAutomaticSync();
    }
  }
  if (areaName === "local" && changes[SYNC_KEY]) refreshLastSync();
});

init();

async function init() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, UI_STATE_KEY]);
  const settings = stored[STORAGE_KEY];
  const uiState = stored[UI_STATE_KEY];
  populateSettings(settings);
  restoreUiState(uiState);
  await Promise.all([refreshAuthStatus(), refreshLastSync()]);

  if (!settings?.gitlabLoginUrl && !settings?.jenkinsLoginUrl) {
    activateTab("settings");
    showStatus("Hãy cấu hình GitLab hoặc Jenkins để bắt đầu.");
  } else {
    activateTab(uiState?.activeTab || "gitlab");
  }
  startAutomaticSync(uiState);
}

function activateTab(name) {
  closeAllSearchOptions();
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#gitlab-panel").classList.toggle("hidden", name !== "gitlab");
  document.querySelector("#jenkins-panel").classList.toggle("hidden", name !== "jenkins");
  document.querySelector("#settings-panel").classList.toggle("hidden", name !== "settings");
  showStatus("");
  if (name === "settings") refreshAuthStatus();
}

async function loadBranches() {
  clearBranches();
  if (!projectSelect.value.trim()) return;
  let project;
  try {
    project = requireListedValue(
      projectSelect,
      projects,
      (item) => item.path_with_namespace,
      "Project không tồn tại. Hãy chọn project trong danh sách."
    );
  } catch {
    return;
  }
  setSearchLoading(sourceSelect, "Đang tải…");
  setSearchLoading(targetSelect, "Đang tải…");
  renderMergeRequestMessage("Đang tải merge request…");

  try {
    const [branchResult, mergeRequestResult] = await Promise.all([
      sendMessage({ type: "GET_BRANCHES", projectId: project.id }),
      sendMessage({ type: "GET_MERGE_REQUESTS", projectId: project.id }),
    ]);
    branches = branchResult;
    mergeRequests = mergeRequestResult;
    fillSearchOptions(sourceSelect, sourceOptions, branches, (item) => item.name, "Chọn source");
    fillSearchOptions(targetSelect, targetOptions, branches, (item) => item.name, "Chọn target");
    updateDefaultMergeRequestTitle();
    renderMergeRequests(mergeRequests);
  } catch (error) {
    clearBranches();
    clearMergeRequests("Không tải được merge request.");
    showStatus(safeMessage(error), "error");
  }
}

async function createMergeRequest() {
  const button = document.querySelector("#create-mr");
  await runBusy(button, async () => {
    const project = requireListedValue(
      projectSelect,
      projects,
      (item) => item.path_with_namespace,
      "Project không tồn tại. Hãy chọn project trong danh sách."
    );
    const sourceBranch = requireListedValue(
      sourceSelect,
      branches,
      (item) => item.name,
      "Source branch không tồn tại. Hãy chọn branch trong danh sách."
    );
    const targetBranch = requireListedValue(
      targetSelect,
      branches,
      (item) => item.name,
      "Target branch không tồn tại. Hãy chọn branch trong danh sách."
    );
    const mergeRequest = await sendMessage({
      type: "CREATE_MERGE_REQUEST",
      payload: {
        projectId: project.id,
        sourceBranch: sourceBranch.name,
        targetBranch: targetBranch.name,
        title: mergeRequestTitle.value,
        description: document.querySelector("#mr-description").value,
        squash: document.querySelector("#squash").checked,
        removeSourceBranch: document.querySelector("#remove-source").checked,
      },
    });
    showStatus(`Đã tạo merge request !${mergeRequest.iid}.`, "success");
    await loadMergeRequests(project.id);
  }, 3_000);
}

async function loadMergeRequests(projectId) {
  renderMergeRequestMessage("Đang tải merge request…");
  try {
    mergeRequests = await sendMessage({ type: "GET_MERGE_REQUESTS", projectId });
    renderMergeRequests(mergeRequests);
  } catch (error) {
    renderMergeRequestMessage("Không tải được merge request.", true);
    throw error;
  }
}

function clearMergeRequests(message = "Chọn project để xem merge request.") {
  mergeRequests = [];
  mergeRequestCount.textContent = "";
  renderMergeRequestMessage(message);
}

function renderMergeRequestMessage(message, isError = false) {
  mergeRequestCount.textContent = "";
  const element = document.createElement("p");
  element.className = `merge-request-empty${isError ? " error" : ""}`;
  element.textContent = message;
  mergeRequestList.replaceChildren(element);
}

function renderMergeRequests(items) {
  mergeRequestCount.textContent = `${items.length} cần xử lý`;
  if (!items.length) {
    renderMergeRequestMessage("Không có merge request cần merge.");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "merge-request-item";

    const top = document.createElement("div");
    top.className = "merge-request-top";
    const title = document.createElement("span");
    title.className = "merge-request-title";
    title.textContent = `!${item.iid} ${item.title}`;
    const state = document.createElement("span");
    const hasConflicts = item.has_conflicts === true || item.detailed_merge_status === "conflicts";
    state.className = `merge-request-state ${hasConflicts ? "conflict" : "clear"}`;
    state.textContent = hasConflicts ? "Có conflict" : "Không conflict";
    top.append(title, state);

    const meta = document.createElement("div");
    meta.className = "merge-request-meta";
    const branchesText = document.createElement("span");
    branchesText.textContent = `${item.source_branch} → ${item.target_branch}`;
    meta.append(branchesText);

    const commits = Array.isArray(item.commits) ? item.commits : [];
    const commitSection = document.createElement("section");
    commitSection.className = "merge-request-commit-section";
    const commitHeading = document.createElement("p");
    commitHeading.className = "merge-request-commit-heading";
    commitHeading.textContent = `Commits (${commits.length})`;
    const commitList = document.createElement("div");
    commitList.className = "merge-request-commit-list";
    if (item.commitsError) {
      const error = document.createElement("p");
      error.className = "merge-request-commit-empty error";
      error.textContent = item.commitsError;
      commitList.append(error);
    } else if (!commits.length) {
      const empty = document.createElement("p");
      empty.className = "merge-request-commit-empty";
      empty.textContent = "Không có commit.";
      commitList.append(empty);
    } else {
      commits.forEach((commit) => commitList.append(createCommitElement(commit)));
    }
    commitSection.append(commitHeading, commitList);

    const actions = document.createElement("div");
    actions.className = "merge-request-actions";
    actions.append(
      mergeRequestActionButton("merge", "Merge", item.iid),
      mergeRequestActionButton("close", "Close", item.iid, "danger")
    );
    if (item.web_url) actions.append(mergeRequestActionButton("view", "Xem GitLab", item.iid, "secondary"));

    card.append(top, meta, commitSection, actions);
    fragment.append(card);
  }
  mergeRequestList.replaceChildren(fragment);
}

function mergeRequestActionButton(action, label, iid, variant = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn small${variant ? ` ${variant}` : ""}`;
  button.dataset.action = action;
  button.dataset.iid = String(iid);
  button.textContent = label;
  return button;
}

async function handleMergeRequestAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const mergeRequest = mergeRequests.find((item) => String(item.iid) === button.dataset.iid);
  if (!mergeRequest) return;

  if (button.dataset.action === "view") {
    await chrome.tabs.create({ url: mergeRequest.web_url });
    return;
  }

  const project = findListedValue(projectSelect.value, projects, (item) => item.path_with_namespace);
  if (!project) {
    showStatus("Project không còn được chọn.", "error");
    return;
  }

  await runBusy(button, async () => {
    const action = button.dataset.action;
    const result = await sendMessage({
      type: action === "merge" ? "MERGE_MERGE_REQUEST" : "CLOSE_MERGE_REQUEST",
      projectId: project.id,
      mergeRequestIid: mergeRequest.iid,
    });
    showStatus(
      action === "merge" ? `Đã merge !${result.iid}.` : `Đã đóng merge request !${result.iid}.`,
      "success"
    );
    await loadMergeRequests(project.id);
  }, 3_000);
}

async function updateSelectedJob() {
  if (!jobSelect.value.trim()) return;
  try {
    const job = requireListedValue(
      jobSelect,
      jobs,
      (item) => item.path,
      "Jenkins job không tồn tại. Hãy chọn job trong danh sách."
    );
    trackedBuild = null;
    startStagePolling(job);
  } catch {
    // Validation is shown by requireListedValue.
  }
}

async function loadStageView(job) {
  const requestId = ++stageViewRequestId;
  stageView.classList.remove("hidden");
  document.querySelector("#jenkins-panel").classList.add("has-stage-view");
  if (!stageViewContent.childElementCount) renderStageViewMessage("Đang tải Stage View…");
  try {
    const runs = await sendMessage({ type: "GET_JENKINS_STAGE_VIEW", jobUrl: job.url });
    if (requestId !== stageViewRequestId) return null;
    latestStageRuns = runs;
    latestStageJobUrl = job.url;
    renderStageView(runs);
    return runs;
  } catch (error) {
    if (requestId !== stageViewRequestId) return null;
    const message = safeMessage(error);
    if (!stageViewDom && stageViewContent.textContent !== message) renderStageViewMessage(message, true);
    return null;
  }
}

function hideStageView() {
  stageViewRequestId += 1;
  stopStagePolling();
  latestStageRuns = [];
  latestStageJobUrl = "";
  stageViewDom = null;
  trackedBuild = null;
  stageView.classList.add("hidden");
  document.querySelector("#jenkins-panel").classList.remove("has-stage-view");
  stageViewContent.replaceChildren();
}

function startStagePolling(job) {
  stopStagePolling();
  const pollId = stagePollId;
  stagePollJobUrl = job.url;
  document.querySelector("#stage-live").classList.remove("hidden");

  const poll = async () => {
    if (pollId !== stagePollId) return;
    const runs = await loadStageView(job);
    if (pollId !== stagePollId) return;
    updateTrackedBuild(job, runs);
    setTimeout(poll, 1_000);
  };

  poll();
}

function stopStagePolling() {
  stagePollId += 1;
  stagePollJobUrl = "";
  document.querySelector("#stage-live").classList.add("hidden");
}

function updateTrackedBuild(job, runs) {
  if (!trackedBuild || trackedBuild.jobUrl !== job.url) return;
  const latestRun = runs?.[0];
  if (!latestRun) {
    showStatus("Đang chờ Jenkins bắt đầu build…");
    return;
  }
  const currentRunKey = pipelineRunKey(latestRun);
  trackedBuild.detected = trackedBuild.detected || (trackedBuild.baselineRunKey
    ? currentRunKey !== trackedBuild.baselineRunKey
    : Number(latestRun.startTimeMillis) >= trackedBuild.triggeredAt - 2_000);
  if (!trackedBuild.detected) {
    showStatus("Đang chờ Jenkins bắt đầu build…");
    return;
  }
  if (isTerminalPipelineStatus(latestRun.status)) {
    const successful = latestRun.status === "SUCCESS";
    showStatus(
      `${latestRun.name || currentRunKey} đã kết thúc: ${latestRun.status}.`,
      successful ? "success" : "error"
    );
    trackedBuild = null;
    return;
  }
  const activeStage = (latestRun.stages ?? []).find((stage) => stage.status === "IN_PROGRESS");
  showStatus(
    `${latestRun.name || currentRunKey}: ${activeStage ? `đang chạy ${activeStage.name}` : latestRun.status || "IN_PROGRESS"}.`
  );
}

function pipelineRunKey(run) {
  return String(run?.id ?? run?.name ?? "");
}

function isTerminalPipelineStatus(statusName) {
  return ["SUCCESS", "FAILED", "ABORTED", "UNSTABLE", "NOT_BUILT"].includes(String(statusName));
}

function renderStageViewMessage(message, isError = false) {
  stageViewDom = null;
  const element = document.createElement("p");
  element.className = `stage-view-message${isError ? " error" : ""}`;
  element.textContent = message;
  stageViewContent.replaceChildren(element);
}

function renderStageView(runs) {
  const stageNames = [];
  for (const run of runs) {
    for (const stage of run.stages ?? []) {
      if (!stageNames.includes(stage.name)) stageNames.push(stage.name);
    }
  }
  if (!runs.length || !stageNames.length) {
    const message = "Job chưa có dữ liệu Pipeline Stage View.";
    if (stageViewContent.textContent !== message) renderStageViewMessage(message);
    return;
  }

  const structureKey = JSON.stringify({
    stageNames,
    runs: runs.map(pipelineRunKey),
  });
  if (stageViewDom?.structureKey === structureKey) {
    updateStageViewDom(runs, stageNames);
    return;
  }

  const table = document.createElement("table");
  table.className = "stage-table";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headerRow.append(createStageCell("th", "Build", "build-column"));
  for (const name of stageNames) headerRow.append(createStageCell("th", name));
  head.append(headerRow);
  table.append(head);

  const body = document.createElement("tbody");
  const averageRow = document.createElement("tr");
  averageRow.className = "stage-average";
  const averageTotal = createStageCell("th", "");
  averageRow.append(averageTotal);
  const averageCells = new Map();
  for (const name of stageNames) {
    const cell = createStageCell("td", "");
    averageCells.set(name, cell);
    averageRow.append(cell);
  }
  body.append(averageRow);

  const runRows = new Map();
  for (const run of runs) {
    const row = document.createElement("tr");
    const runHeader = createStageCell("th", run.name || `#${run.id}`);
    const runStatus = document.createElement("span");
    runStatus.className = "stage-run-status";
    runHeader.append(runStatus);
    row.append(runHeader);

    const cells = new Map();
    for (const name of stageNames) {
      const cell = createStageCell("td", "", "stage-cell not-executed");
      cells.set(name, cell);
      row.append(cell);
    }
    runRows.set(pipelineRunKey(run), { status: runStatus, cells });
    body.append(row);
  }
  table.append(body);
  stageViewContent.replaceChildren(table);
  stageViewDom = { structureKey, averageTotal, averageCells, runRows };
  updateStageViewDom(runs, stageNames);
}

function updateStageViewDom(runs, stageNames) {
  stageViewDom.averageTotal.textContent = `TB ${formatDuration(average(runs.map((run) => run.durationMillis)))}`;
  for (const name of stageNames) {
    const durations = runs
      .map((run) => (run.stages ?? []).find((stage) => stage.name === name)?.durationMillis)
      .filter(Number.isFinite);
    stageViewDom.averageCells.get(name).textContent = formatDuration(average(durations));
  }

  for (const run of runs) {
    const row = stageViewDom.runRows.get(pipelineRunKey(run));
    if (!row) continue;
    row.status.textContent = run.status || "UNKNOWN";
    for (const name of stageNames) {
      const stage = (run.stages ?? []).find((item) => item.name === name);
      updateStageCell(row.cells.get(name), stage);
    }
  }
}

function updateStageCell(cell, stage) {
  const statusName = String(stage?.status ?? "NOT_EXECUTED").toLowerCase().replaceAll("_", "-");
  cell.className = `stage-cell ${statusName}`;
  cell.textContent = formatStageCell(stage);
  cell.title = stage?.status || "NOT_EXECUTED";
}

function formatStageCell(stage) {
  if (!stage) return "—";
  const duration = formatDuration(stage.durationMillis);
  if (stage.status === "IN_PROGRESS") return `Đang chạy · ${duration}`;
  if (stage.status === "FAILED") return `Lỗi · ${duration}`;
  if (stage.status === "ABORTED") return `Đã dừng · ${duration}`;
  if (stage.status === "PAUSED_PENDING_INPUT") return `Đang chờ · ${duration}`;
  return duration;
}

function createStageCell(tagName, text, className = "") {
  const cell = document.createElement(tagName);
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function average(values) {
  const numbers = values.filter(Number.isFinite);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : 0;
}

function formatDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

async function triggerBuild() {
  const button = document.querySelector("#trigger-build");
  await runBusy(button, async () => {
    const job = requireListedValue(
      jobSelect,
      jobs,
      (item) => item.path,
      "Jenkins job không tồn tại. Hãy chọn job trong danh sách."
    );
    const baselineRunKey = latestStageJobUrl === job.url ? pipelineRunKey(latestStageRuns[0]) : "";
    const triggeredAt = Date.now();
    await sendMessage({
      type: "TRIGGER_BUILD",
      jobUrl: job.url,
      parameters: "",
    });
    showStatus(`Đã đưa ${job.path} vào Jenkins queue.`, "success");
    trackedBuild = { jobUrl: job.url, baselineRunKey, triggeredAt, detected: false };
    if (stagePollJobUrl !== job.url) startStagePolling(job);
  }, 3_000);
}

function populateSettings(settings) {
  setValue("gitlab-login-url", settings?.gitlabLoginUrl);
  setValue("gitlab-username", settings?.gitlabUsername);
  setValue("gitlab-password", settings?.gitlabPassword);
  setValue("jenkins-login-url", settings?.jenkinsLoginUrl);
  setValue("jenkins-username", settings?.jenkinsUsername);
  setValue("jenkins-password", settings?.jenkinsPassword);
}

function restoreUiState(uiState) {
  if (!uiState) return;
  lastPersistedUiState = uiState;
  projectSelect.value = uiState.projectValue ?? "";
  sourceSelect.value = uiState.sourceBranch ?? "";
  targetSelect.value = uiState.targetBranch ?? "";
  jobSelect.value = uiState.jobValue ?? "";
  lastAutomaticMergeRequestTitle = uiState.automaticMergeRequestTitle ?? "";

  for (const id of persistedControlIds) {
    if (!Object.prototype.hasOwnProperty.call(uiState.controls ?? {}, id)) continue;
    const control = document.querySelector(`#${id}`);
    if (control.type === "checkbox") control.checked = Boolean(uiState.controls[id]);
    else control.value = uiState.controls[id] ?? "";
  }
}

function persistUiState() {
  const project = findListedValue(projectSelect.value, projects, (item) => item.path_with_namespace);
  const job = findListedValue(jobSelect.value, jobs, (item) => item.path);
  const controls = {};
  for (const id of persistedControlIds) {
    const control = document.querySelector(`#${id}`);
    controls[id] = control.type === "checkbox" ? control.checked : control.value;
  }
  const uiState = {
    activeTab: document.querySelector(".tab.active")?.dataset.tab ?? "gitlab",
    projectId: project?.id ?? (
      projectSelect.value === lastPersistedUiState.projectValue ? lastPersistedUiState.projectId : null
    ),
    projectValue: projectSelect.value,
    sourceBranch: sourceSelect.value,
    targetBranch: targetSelect.value,
    jobUrl: job?.url ?? (jobSelect.value === lastPersistedUiState.jobValue ? lastPersistedUiState.jobUrl : null),
    jobValue: jobSelect.value,
    automaticMergeRequestTitle: lastAutomaticMergeRequestTitle,
    controls,
  };
  lastPersistedUiState = uiState;
  void chrome.storage.local.set({ [UI_STATE_KEY]: uiState });
}

async function login(service) {
  const button = document.querySelector(`#login-${service}`);
  await runBusy(button, async () => {
    await saveServiceSettings(service);
    activeLoginServices.add(service);
    try {
      await sendMessage({
        type: service === "gitlab" ? "LOGIN_GITLAB" : "LOGIN_JENKINS",
      });
      if (activeLoginServices.has(service)) {
        showStatus(`Đang đăng nhập ${service === "gitlab" ? "GitLab" : "Jenkins"} trong nền…`);
      }
    } catch (error) {
      activeLoginServices.delete(service);
      throw error;
    }
  });
}

function handleAuthenticationChange(auth) {
  for (const service of [...activeLoginServices]) {
    const state = auth?.[service];
    const label = service === "gitlab" ? "GitLab" : "Jenkins";
    if (state?.authenticated) {
      activeLoginServices.delete(service);
      showStatus(`Đã đăng nhập ${label}${state.username ? `: ${state.username}` : ""}.`, "success");
    } else if (state && !state.pending && state.error) {
      activeLoginServices.delete(service);
      showStatus(state.error, "error");
    }
  }
}

function startAutomaticSync(initialUiState) {
  runAutomaticSync(initialUiState);
  setInterval(runAutomaticSync, 30_000);
}

async function runAutomaticSync(initialUiState = {}) {
  if (autoSyncInProgress) return;
  if ([projectSelect, sourceSelect, targetSelect, jobSelect].includes(document.activeElement)) return;
  autoSyncInProgress = true;
  document.querySelector("#gitlab-dot").className = "status-dot syncing";
  document.querySelector("#jenkins-dot").className = "status-dot syncing";
  const selection = {
    projectId: findListedValue(projectSelect.value, projects, (item) => item.path_with_namespace)?.id
      ?? initialUiState.projectId,
    projectValue: projectSelect.value,
    sourceBranch: sourceSelect.value,
    targetBranch: targetSelect.value,
    jobUrl: findListedValue(jobSelect.value, jobs, (item) => item.path)?.url ?? initialUiState.jobUrl,
    jobValue: jobSelect.value,
  };
  try {
    const result = await sendMessage({
      type: "SYNC_ALL",
      projectId: selection.projectId,
    });
    applySyncResult(result, selection);
    await Promise.all([refreshAuthStatus(), refreshLastSync()]);
  } catch (error) {
    if (!trackedBuild) showStatus(safeMessage(error), "error");
  } finally {
    autoSyncInProgress = false;
    await refreshAuthStatus();
  }
}

function applySyncResult(result, selection = {}) {
  if (result.projects) {
    projects = result.projects;
    fillSearchOptions(projectSelect, projectOptions, projects, (item) => item.path_with_namespace, "Chọn project");
    const selectedProjectId = selection.projectId ?? result.projectId;
    const project = projects.find((item) => String(item.id) === String(selectedProjectId));
    if (project) projectSelect.value = project.path_with_namespace;
    else if (selection.projectValue) {
      clearBranches();
      clearMergeRequests();
    }
  }
  if (result.jobs) {
    jobs = result.jobs;
    fillSearchOptions(jobSelect, jobOptions, jobs, (item) => item.path, "Chọn job");
    const selectedJob = jobs.find((item) => item.url === selection.jobUrl);
    if (selectedJob) {
      jobSelect.value = selectedJob.path;
      if (stagePollJobUrl !== selectedJob.url) startStagePolling(selectedJob);
    } else if (selection.jobUrl) hideStageView();
  }
  if (Array.isArray(result.branches) && result.projectId) {
    branches = result.branches;
    fillSearchOptions(sourceSelect, sourceOptions, branches, (item) => item.name, "Chọn source");
    fillSearchOptions(targetSelect, targetOptions, branches, (item) => item.name, "Chọn target");
    if (branches.some((branch) => branch.name === selection.sourceBranch)) sourceSelect.value = selection.sourceBranch;
    if (branches.some((branch) => branch.name === selection.targetBranch)) targetSelect.value = selection.targetBranch;
    updateDefaultMergeRequestTitle();
    loadBranchComparison();
  }
  if (Array.isArray(result.mergeRequests) && result.projectId) {
    mergeRequests = result.mergeRequests;
    renderMergeRequests(mergeRequests);
  }
  persistUiState();
}

async function testConnections() {
  await runBusy(document.querySelector("#test-connections"), async () => {
    await persistSettings();
    const response = await sendMessage({ type: "TEST_CONNECTIONS" });
    const serviceResult = (label, result) => result.skipped
      ? `${label}: Chưa cấu hình`
      : result.ok ? `${label}: OK (${result.label})` : `${label}: ${result.error}`;
    const gitlab = serviceResult("GitLab", response.gitlab);
    const jenkins = serviceResult("Jenkins", response.jenkins);
    const tested = [response.gitlab, response.jenkins].filter((result) => !result.skipped);
    showStatus(`${gitlab}\n${jenkins}`, tested.length && tested.every((result) => result.ok) ? "success" : "error");
  });
}

function persistSettings() {
  return enqueueSettingsWrite(readSettingsFromUi());
}

async function saveServiceSettings(service) {
  await persistSettings();
  const settings = readSettingsFromUi();
  const label = service === "gitlab" ? "GitLab" : "Jenkins";
  const loginUrlKey = `${service}LoginUrl`;
  const usernameKey = `${service}Username`;
  const passwordKey = `${service}Password`;
  settings[loginUrlKey] = normalizeBaseUrl(settings[loginUrlKey]);
  serviceBaseFromLoginUrl(settings[loginUrlKey], service);
  settings[usernameKey] = settings[usernameKey].trim();
  if (!settings[usernameKey]) throw new Error(`Thiếu tài khoản ${label}.`);
  if (!settings[passwordKey] || settings[passwordKey].length > 1024) throw new Error(`Mật khẩu ${label} không hợp lệ.`);
  const granted = await chrome.permissions.request({ origins: [permissionPattern(settings[loginUrlKey])] });
  if (!granted) throw new Error(`Chrome chưa cấp quyền truy cập ${label} host.`);
  setValue(`${service}-login-url`, settings[loginUrlKey]);
  setValue(`${service}-username`, settings[usernameKey]);
  await enqueueSettingsWrite(settings);
}

function readSettingsFromUi() {
  return {
    gitlabLoginUrl: value("gitlab-login-url"),
    gitlabUsername: value("gitlab-username").trim(),
    gitlabPassword: value("gitlab-password"),
    jenkinsLoginUrl: value("jenkins-login-url"),
    jenkinsUsername: value("jenkins-username").trim(),
    jenkinsPassword: value("jenkins-password"),
  };
}

function enqueueSettingsWrite(settings) {
  settingsWritePromise = settingsWritePromise.then(() => storeSettings(settings));
  return settingsWritePromise;
}

async function storeSettings(settings) {
  const stored = await chrome.storage.local.get([STORAGE_KEY, AUTH_KEY]);
  const previous = stored[STORAGE_KEY] ?? {};
  const auth = { ...(stored[AUTH_KEY] ?? {}) };
  for (const service of ["gitlab", "jenkins"]) {
    const key = `${service}LoginUrl`;
    if (previous[key] !== settings[key]) auth[service] = null;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: settings, [AUTH_KEY]: auth });
  await removeChangedHostPermissions(previous, settings);
}

async function refreshAuthStatus() {
  try {
    const auth = await sendMessage({ type: "GET_AUTH_STATUS" });
    renderServiceStatus("gitlab", auth.gitlab);
    renderServiceStatus("jenkins", auth.jenkins);
  } catch (error) {
    showStatus(safeMessage(error), "error");
  }
}

function renderServiceStatus(service, auth) {
  let text = "Chưa đăng nhập.";
  let className = "auth-status";
  if (auth?.authenticated) {
    text = `Đã đăng nhập: ${auth.username}`;
    className += " success";
  } else if (auth?.pending) {
    text = "Đang chờ hoàn tất đăng nhập…";
  } else if (auth?.error) {
    text = auth.error;
    className += " error";
  }
  const element = document.querySelector(`#${service}-auth-status`);
  element.textContent = text;
  element.className = className;
  document.querySelector(`#${service}-dot`).className = `status-dot ${auth?.authenticated ? "ok" : "warning"}`;
}

async function refreshLastSync() {
  const sync = (await chrome.storage.local.get(SYNC_KEY))[SYNC_KEY];
  document.querySelector("#last-sync").textContent = sync?.finishedAt
    ? `Lần cuối: ${new Date(sync.finishedAt).toLocaleString("vi-VN")}`
    : "Chưa đồng bộ";
}

async function removeChangedHostPermissions(previous, current) {
  for (const service of ["gitlab", "jenkins"]) {
    const key = `${service}LoginUrl`;
    if (!previous[key] || previous[key] === current[key]) continue;
    try {
      await chrome.permissions.remove({ origins: [permissionPattern(previous[key])] });
    } catch {
      // A partially entered previous URL never received a host permission.
    }
  }
}

function setSearchLoading(input, placeholder) {
  const config = searchSelectData.get(input);
  if (config) {
    config.items = [];
    config.visibleItems = [];
    config.list.replaceChildren();
  }
  closeSearchOptions(input);
  input.value = "";
  input.placeholder = placeholder;
  input.disabled = true;
  input.setCustomValidity("");
}

function fillSearchOptions(input, list, items, getLabel, placeholder) {
  searchSelectData.set(input, { input, list, items, getLabel, visibleItems: [], activeIndex: -1 });
  list.replaceChildren();
  input.value = "";
  input.placeholder = placeholder;
  input.disabled = false;
  input.setCustomValidity("");
}

function setupSearchSelect(input) {
  input.addEventListener("click", () => {
    if (input.getAttribute("aria-expanded") === "true") {
      closeSearchOptions(input);
      return;
    }
    openSearchOptions(input);
  });
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    openSearchOptions(input);
  });
  input.addEventListener("keydown", (event) => handleSearchSelectKeydown(event, input));
  input.addEventListener("blur", () => setTimeout(() => closeSearchOptions(input), 0));
}

function openSearchOptions(input) {
  const config = searchSelectData.get(input);
  if (!config || input.disabled) return;
  renderSearchOptions(config, input.value);
  config.list.classList.remove("hidden");
  input.closest(".search-select")?.classList.add("open");
  input.setAttribute("aria-expanded", "true");
}

function closeSearchOptions(input) {
  const config = searchSelectData.get(input);
  config?.list.classList.add("hidden");
  input.closest(".search-select")?.classList.remove("open");
  input.setAttribute("aria-expanded", "false");
}

function closeAllSearchOptions() {
  for (const input of searchSelectData.keys()) closeSearchOptions(input);
}

function renderSearchOptions(config, query) {
  config.visibleItems = config.items
    .map((item) => ({ item, score: searchMatchScore(config.getLabel(item), query) }))
    .filter((match) => match.score >= 0)
    .sort((left, right) => right.score - left.score || String(config.getLabel(left.item)).localeCompare(config.getLabel(right.item)))
    .slice(0, 150);
  config.visibleItems = config.visibleItems.map((match) => match.item);
  config.activeIndex = -1;
  config.list.replaceChildren();

  if (!config.visibleItems.length) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = "Không có kết quả";
    config.list.append(empty);
    return;
  }

  config.visibleItems.forEach((item, index) => {
    const option = document.createElement("div");
    option.id = `${config.list.id}-option-${index}`;
    option.className = "search-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.textContent = config.getLabel(item);
    option.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectSearchOption(config, item);
    });
    config.list.append(option);
  });
}

function handleSearchSelectKeydown(event, input) {
  const config = searchSelectData.get(input);
  if (!config) return;
  if (event.key === "Escape") {
    closeSearchOptions(input);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  event.preventDefault();
  if (input.getAttribute("aria-expanded") !== "true") openSearchOptions(input);
  if (!config.visibleItems.length) return;

  if (event.key === "Enter") {
    selectSearchOption(config, config.visibleItems[Math.max(config.activeIndex, 0)]);
    return;
  }
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex = config.activeIndex < 0
    ? (direction > 0 ? 0 : config.visibleItems.length - 1)
    : (config.activeIndex + direction + config.visibleItems.length) % config.visibleItems.length;
  setActiveSearchOption(config, nextIndex);
}

function setActiveSearchOption(config, index) {
  config.activeIndex = index;
  [...config.list.querySelectorAll(".search-option")].forEach((option, optionIndex) => {
    const active = optionIndex === index;
    option.classList.toggle("active", active);
    option.setAttribute("aria-selected", String(active));
    if (active) option.scrollIntoView({ block: "nearest" });
  });
}

function selectSearchOption(config, item) {
  config.input.value = config.getLabel(item);
  config.input.setCustomValidity("");
  closeSearchOptions(config.input);
  config.input.dispatchEvent(new Event(SEARCH_SELECT_CHANGE_EVENT, { bubbles: true }));
}

function clearBranches() {
  branches = [];
  sourceOptions.replaceChildren();
  targetOptions.replaceChildren();
  setSearchLoading(sourceSelect, "Chọn project trước");
  setSearchLoading(targetSelect, "Chọn project trước");
  updateDefaultMergeRequestTitle();
  clearBranchComparison();
}

function updateDefaultMergeRequestTitle() {
  const sourceBranch = findListedValue(sourceSelect.value, branches, (item) => item.name);
  const targetBranch = findListedValue(targetSelect.value, branches, (item) => item.name);
  const nextTitle = sourceBranch && targetBranch
    ? `UPDATE_merge branch ${sourceBranch.name} to ${targetBranch.name}`
    : "";
  const currentTitle = mergeRequestTitle.value.trim();
  if (!currentTitle || currentTitle === lastAutomaticMergeRequestTitle) {
    mergeRequestTitle.value = nextTitle;
  }
  lastAutomaticMergeRequestTitle = nextTitle;
}

function selectedBranchPair() {
  const project = findListedValue(projectSelect.value, projects, (item) => item.path_with_namespace);
  const sourceBranch = findListedValue(sourceSelect.value, branches, (item) => item.name);
  const targetBranch = findListedValue(targetSelect.value, branches, (item) => item.name);
  if (!project || !sourceBranch || !targetBranch || sourceBranch.name === targetBranch.name) return null;
  return { project, sourceBranch, targetBranch };
}

async function loadBranchComparison() {
  const pair = selectedBranchPair();
  if (!pair) {
    clearBranchComparison();
    return;
  }

  const requestId = ++branchCompareRequestId;
  branchCompare.classList.remove("hidden");
  renderBranchCompareMessage("Đang tải danh sách commit…");
  try {
    const comparison = await sendMessage({
      type: "GET_BRANCH_COMPARE",
      projectId: pair.project.id,
      sourceBranch: pair.sourceBranch.name,
      targetBranch: pair.targetBranch.name,
    });
    if (requestId !== branchCompareRequestId) return;
    renderBranchComparison(comparison);
  } catch (error) {
    if (requestId !== branchCompareRequestId) return;
    renderBranchCompareMessage(safeMessage(error), true);
  }
}

function clearBranchComparison() {
  branchCompareRequestId += 1;
  branchCompare.classList.add("hidden");
  branchCompareCount.textContent = "";
  branchCompareList.replaceChildren();
}

function renderBranchCompareMessage(message, isError = false) {
  branchCompareCount.textContent = "";
  const element = document.createElement("p");
  element.className = `branch-compare-empty${isError ? " error" : ""}`;
  element.textContent = message;
  branchCompareList.replaceChildren(element);
}

function renderBranchComparison(comparison) {
  const commits = Array.isArray(comparison?.commits) ? comparison.commits : [];
  branchCompareCount.textContent = `${commits.length} commit`;
  if (!commits.length) {
    renderBranchCompareMessage("Không có commit khác biệt giữa hai branch.");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const commit of commits) {
    fragment.append(createCommitElement(commit));
  }
  branchCompareList.replaceChildren(fragment);
}

function createCommitElement(commit) {
  const row = document.createElement("article");
  row.className = "branch-commit";
  const sha = document.createElement("span");
  sha.className = "branch-commit-sha";
  sha.textContent = commit.short_id || String(commit.id ?? "").slice(0, 8);
  const title = document.createElement("span");
  title.className = "branch-commit-title";
  title.textContent = commit.title || "Commit không có tiêu đề";
  const meta = document.createElement("span");
  meta.className = "branch-commit-meta";
  const dateValue = commit.created_at || commit.committed_date || commit.authored_date;
  const date = dateValue ? new Date(dateValue).toLocaleString("vi-VN") : "";
  meta.textContent = [commit.author_name, date].filter(Boolean).join(" · ");
  row.append(sha, title, meta);
  return row;
}

function findListedValue(value, items, getLabel) {
  const normalized = String(value ?? "").trim().toLocaleLowerCase("vi");
  if (!normalized) return null;
  return items.find((item) => String(getLabel(item)).trim().toLocaleLowerCase("vi") === normalized) ?? null;
}

function requireListedValue(input, items, getLabel, errorMessage) {
  const item = findListedValue(input.value, items, getLabel);
  if (!item) {
    input.setCustomValidity(errorMessage);
    input.reportValidity();
    throw new Error(errorMessage);
  }
  input.value = getLabel(item);
  input.setCustomValidity("");
  return item;
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    if (response?.error === "Yêu cầu không được hỗ trợ.") {
      throw new Error("Service worker đang chạy phiên bản cũ. Hãy reload extension tại chrome://extensions rồi mở lại popup.");
    }
    throw new Error(response?.error || "Không nhận được phản hồi từ extension.");
  }
  return response.data;
}

async function runBusy(button, action, cooldownMs = 0) {
  if (button.disabled) return;
  button.disabled = true;
  showStatus("Đang xử lý…");
  let completed = false;
  try {
    await action();
    completed = true;
  } catch (error) {
    showStatus(safeMessage(error), "error");
  } finally {
    if (completed && cooldownMs > 0) {
      setTimeout(() => { button.disabled = false; }, cooldownMs);
    } else {
      button.disabled = false;
    }
  }
}

function value(id) { return document.querySelector(`#${id}`).value; }
function setValue(id, val) { document.querySelector(`#${id}`).value = val ?? ""; }
function showStatus(message, type = "") {
  status.textContent = message;
  status.className = `status ${type}`.trim();
}
