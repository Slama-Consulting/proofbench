import { describe, expect, it } from "vitest";
import { parseRef, type RefContext } from "../src/refs.js";

const ctx: RefContext = {
  jira: { host: "jira.example.com", basePath: "" },
  jiraConfigured: true,
  linearConfigured: false,
  gitlabHost: "gitlab.example.com",
};

describe("parseRef: valid refs", () => {
  const table: Array<[string, Parameters<typeof parseRef>[1], unknown]> = [
    ["PROJ-123", undefined, { provider: "jira", key: "PROJ-123" }],
    ["https://jira.example.com/browse/PROJ-123", undefined, { provider: "jira", key: "PROJ-123" }],
    ["https://jira.example.com/browse/PROJ-123/", undefined, { provider: "jira", key: "PROJ-123" }],
    ["ENG-12", "linear", { provider: "linear", key: "ENG-12" }],
    ["https://linear.app/acme/issue/ENG-12/some-title", undefined, { provider: "linear", key: "ENG-12" }],
    ["https://github.com/octo/repo/issues/42", undefined, { provider: "github", owner: "octo", repo: "repo", number: 42, hint: "issue" }],
    ["https://github.com/octo/repo/pull/7/files", undefined, { provider: "github", owner: "octo", repo: "repo", number: 7, hint: "pull" }],
    ["octo/repo#42", undefined, { provider: "github", owner: "octo", repo: "repo", number: 42, hint: "any" }],
    ["https://gitlab.example.com/group/project/-/issues/7", undefined, { provider: "gitlab", project: "group/project", number: 7, type: "issue" }],
    ["https://gitlab.example.com/g/sub/project/-/merge_requests/9", undefined, { provider: "gitlab", project: "g/sub/project", number: 9, type: "mr" }],
    ["group/sub/project#7", undefined, { provider: "gitlab", project: "group/sub/project", number: 7, type: "issue" }],
    ["group/project#7", "gitlab", { provider: "gitlab", project: "group/project", number: 7, type: "issue" }],
    ["group/project!3", undefined, { provider: "gitlab", project: "group/project", number: 3, type: "mr" }],
    ["  PROJ-9  ", undefined, { provider: "jira", key: "PROJ-9" }],
  ];
  it.each(table)("%s", (ref, hint, expected) => {
    expect(parseRef(ref, hint, ctx)).toEqual(expected);
  });

  it("a Jira base URL with a context path", () => {
    const c: RefContext = { ...ctx, jira: { host: "jira.example.com", basePath: "/jira" } };
    expect(parseRef("https://jira.example.com/jira/browse/PROJ-1", undefined, c)).toEqual({ provider: "jira", key: "PROJ-1" });
    expect(() => parseRef("https://jira.example.com/browse/PROJ-1", undefined, c)).toThrow();
  });
});

describe("parseRef: refused refs", () => {
  const bad: Array<[string, string]> = [
    ["", "empty"],
    ["hello", "not a ticket"],
    ["proj-123", "not a ticket"],
    ["PROJ-1234567890", "not a ticket"],
    ["octo/repo#abc", "not a ticket"],
    ["octo/repo#1234567890", "not a ticket"],
    ["#42", "not a ticket"],
    ["octo/../repo#1", "invalid"],
    ["https://jira.example.com/browse/proj-1", "Jira URL"],
    ["https://jira.example.com/secure/Dashboard.jspa", "Jira URL"],
    ["https://github.com/octo/repo/issues/abc", "digits"],
    ["https://github.com/octo/repo/issues/1234567890", "digits"],
    ["https://github.com/octo/repo/wiki", "GitHub URL"],
    ["https://github.com.evil.example/octo/repo/issues/1", "not a configured tracker host"],
    ["https://evilgithub.com/octo/repo/issues/1", "not a configured tracker host"],
    ["https://github.com@evil.example/octo/repo/issues/1", "credentials"],
    ["https://user:pass@github.com/octo/repo/issues/1", "credentials"],
    ["https://evil.example/browse/PROJ-1", "not a configured tracker host"],
    ["https://jira.example.com.evil.example/browse/PROJ-1", "not a configured tracker host"],
    ["https://jira.example.com:8443/browse/PROJ-1", "not a configured tracker host"],
    ["https://gitlab.example.com:8443/g/p/-/issues/1", "not a configured tracker host"],
    ["https://gitlab.com/g/p/-/issues/1", "not a configured tracker host"],
    ["http://github.com/octo/repo/issues/1", "HTTPS"],
    ["http://jira.example.com/browse/PROJ-1", "HTTPS"],
    ["ftp://github.com/octo/repo/issues/1", "HTTPS"],
    ["javascript:alert(1)", "HTTPS"],
    ["file:///etc/passwd", "HTTPS"],
    ["https://gitlab.example.com/g/p/issues/1", "GitLab URL"],
    ["https://gitlab.example.com/p/-/issues/1", "GitLab URL"],
    ["https://github.com/octo/repo/issues/1 extra", "whitespace"],
    ["https://github.com/octo/repo/issues/1\nHost: evil", "whitespace"],
    ["https://linear.app/acme/project/ENG-1", "Linear URL"],
  ];
  it.each(bad)("%s", (ref, fragment) => {
    expect(() => parseRef(ref, undefined, ctx)).toThrow(new RegExp(fragment, "i"));
  });

  it("refuses a URL whose provider differs from the requested one", () => {
    expect(() => parseRef("https://github.com/octo/repo/issues/1", "jira", ctx)).toThrow(/provider/);
  });

  it("refuses a key for github or gitlab", () => {
    expect(() => parseRef("PROJ-1", "github", ctx)).toThrow();
    expect(() => parseRef("PROJ-1", "gitlab", ctx)).toThrow();
  });

  it("a key is ambiguous when Jira and Linear are both configured", () => {
    expect(() => parseRef("ENG-12", undefined, { ...ctx, linearConfigured: true })).toThrow(/ambiguous/);
    expect(parseRef("ENG-12", "linear", { ...ctx, linearConfigured: true })).toEqual({ provider: "linear", key: "ENG-12" });
  });

  it("a key with nothing configured asks for a provider", () => {
    expect(() => parseRef("PROJ-1", undefined, { ...ctx, jiraConfigured: false })).toThrow(/provider/);
  });

  it("host names are case-insensitive but nothing else is relaxed", () => {
    expect(parseRef("https://GitHub.COM/octo/repo/issues/1", undefined, ctx).provider).toBe("github");
  });

  it("plain http works only for localhost and only behind the option", () => {
    const c: RefContext = { ...ctx, gitlabHost: "localhost", allowHttpLocalhost: true };
    expect(parseRef("http://localhost/g/p/-/issues/1", undefined, c).provider).toBe("gitlab");
    expect(() => parseRef("http://localhost/g/p/-/issues/1", undefined, { ...c, allowHttpLocalhost: false })).toThrow(/HTTPS/);
    expect(() => parseRef("http://github.com/o/r/issues/1", undefined, c)).toThrow(/HTTPS/);
  });
});
