import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSameOrigin,
  createActionGuard,
  encodeProjectId,
  flattenJenkinsJobs,
  isJenkinsAuthenticated,
  normalizeBaseUrl,
  normalizeCommitResponse,
  parseBuildParameters,
  permissionPattern,
  searchMatchScore,
  serviceBaseFromLoginUrl,
} from "../src/shared.js";

test("normalizes service URL and keeps an installation path", () => {
  assert.equal(normalizeBaseUrl(" https://example.test/gitlab///?x=1#top "), "https://example.test/gitlab");
});

test("rejects unsupported URL protocols", () => {
  assert.throws(() => normalizeBaseUrl("file:///tmp/gitlab"), /http/);
});

test("rejects credentials embedded in a service URL", () => {
  assert.throws(() => normalizeBaseUrl("https://user:secret@example.test"), /username/);
});

test("creates an origin permission pattern", () => {
  assert.equal(permissionPattern("https://example.test/gitlab"), "https://example.test/*");
});

test("encodes a GitLab namespaced project id", () => {
  assert.equal(encodeProjectId("team/project"), "team%2Fproject");
});

test("parses build parameters and preserves equals in values", () => {
  const params = parseBuildParameters("BRANCH=feature/demo\n# comment\nURL=https://x.test?a=b");
  assert.deepEqual([...params.entries()], [
    ["BRANCH", "feature/demo"],
    ["URL", "https://x.test?a=b"],
  ]);
});

test("reports malformed build parameter lines", () => {
  assert.throws(() => parseBuildParameters("BRANCH"), /Dòng 1/);
});

test("allows Jenkins job URLs only on the configured origin", () => {
  assert.equal(
    assertSameOrigin("https://ci.test/job/api/", "https://ci.test/jenkins"),
    "https://ci.test/job/api/"
  );
  assert.throws(() => assertSameOrigin("https://evil.test/job/api", "https://ci.test"), /không được tin cậy/);
});

test("does not treat Jenkins anonymous access as authenticated", () => {
  assert.equal(isJenkinsAuthenticated({ authenticated: true, name: "anonymous" }), false);
  assert.equal(isJenkinsAuthenticated({ authenticated: false, name: "thaidp4" }), false);
  assert.equal(isJenkinsAuthenticated({ authenticated: true, name: "thaidp4" }), true);
});

test("blocks duplicate actions while pending and during cooldown", async () => {
  const runActionOnce = createActionGuard();
  let finishAction;
  const pendingAction = new Promise((resolve) => { finishAction = resolve; });
  const first = runActionOnce("build:demo", 3_000, "duplicate", () => pendingAction);

  await assert.rejects(
    runActionOnce("build:demo", 3_000, "duplicate", async () => "second"),
    /duplicate/
  );
  finishAction("queued");
  assert.equal(await first, "queued");
  await assert.rejects(
    runActionOnce("build:demo", 3_000, "duplicate", async () => "third"),
    /duplicate/
  );
});

test("normalizes GitLab commit responses from array and wrapped formats", () => {
  const commits = [{ id: "abc", title: "Update" }];
  assert.deepEqual(normalizeCommitResponse(commits), commits);
  assert.deepEqual(normalizeCommitResponse({ commits }), commits);
  assert.deepEqual(normalizeCommitResponse({}), []);
});

test("flattens nested Jenkins folders into searchable job paths", () => {
  const jobs = flattenJenkinsJobs([
    {
      name: "Team",
      url: "https://ci.example.com/job/Team/",
      _class: "com.cloudbees.hudson.plugins.folder.Folder",
      jobs: [
        {
          name: "Platform",
          url: "https://ci.example.com/job/Team/job/Platform/",
          _class: "com.cloudbees.hudson.plugins.folder.Folder",
          jobs: [
            {
              name: "Service",
              url: "https://ci.example.com/job/Team/job/Platform/job/Service/",
              _class: "com.cloudbees.hudson.plugins.folder.Folder",
              jobs: [
                {
                  name: "Deploy",
                  url: "https://ci.example.com/job/Team/job/Platform/job/Service/job/Deploy/",
                  _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob",
                },
              ],
            },
          ],
        },
      ],
    },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].path, "Team/job/Platform/job/Service/job/Deploy");
});

test("matches multi-word fuzzy searches against Jenkins path segments", () => {
  const path = "Development/job/Platform/job/Calendar-Service/job/Deploy";
  assert.ok(searchMatchScore(path, "dev calendar") >= 0);
  assert.equal(searchMatchScore(path, "production payments"), -1);
});

test("derives API base URLs from the configured login pages", () => {
  assert.equal(
    serviceBaseFromLoginUrl("https://gitlab.example.com/users/sign_in", "gitlab"),
    "https://gitlab.example.com"
  );
  assert.equal(
    serviceBaseFromLoginUrl("https://jenkins.example.com/login", "jenkins"),
    "https://jenkins.example.com"
  );
});

test("rejects a service URL that is not a login page", () => {
  assert.throws(() => serviceBaseFromLoginUrl("https://gitlab.example.com", "gitlab"), /users\/sign_in/);
});

test("requires users to enter both service login URLs", () => {
  assert.throws(() => serviceBaseFromLoginUrl("", "gitlab"), /nhập GitLab login URL/);
  assert.throws(() => serviceBaseFromLoginUrl("  ", "jenkins"), /nhập Jenkins login URL/);
});

test("reports malformed service URLs clearly", () => {
  assert.throws(() => serviceBaseFromLoginUrl("gitlab.example.com/users/sign_in", "gitlab"), /URL không hợp lệ/);
});
