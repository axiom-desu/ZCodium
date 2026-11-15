import { describe, expect, it } from "vitest";
import {
  createWorkspaceFileTreeHtmlBrowserUrl,
  isWorkspaceFileTreeHtmlFile,
  shouldOpenWorkspaceFileTreeHtmlInBrowser,
  shouldResetFileManagerLayout,
} from "../src/workspace-file-tree/helpers.js";

const htmlFile = { path: "/w/index.html", type: "file" as const };
const upperHtmlFile = { path: "/w/INDEX.HTM", type: "file" as const };
const markdownFile = { path: "/w/README.md", type: "file" as const };
const directory = { path: "/w/index.html", type: "directory" as const };

describe("文件树 HTML 单击打开方式（A4）", () => {
  it("只有本地 HTML 文件才生成浏览器 URL", () => {
    expect(isWorkspaceFileTreeHtmlFile(htmlFile)).toBe(true);
    expect(isWorkspaceFileTreeHtmlFile(upperHtmlFile)).toBe(true);
    expect(isWorkspaceFileTreeHtmlFile(markdownFile)).toBe(false);
    expect(isWorkspaceFileTreeHtmlFile(directory)).toBe(false);
    expect(createWorkspaceFileTreeHtmlBrowserUrl(markdownFile)).toBeNull();
    expect(createWorkspaceFileTreeHtmlBrowserUrl(htmlFile)).toContain("index.html");
  });

  it("开关关闭时单击 HTML 仍走源码预览", () => {
    expect(
      shouldOpenWorkspaceFileTreeHtmlInBrowser({
        row: htmlFile,
        htmlClickOpensBrowser: false,
        isRemoteWorkspace: false,
        hasBrowserOpener: true,
      }),
    ).toBe(false);
  });

  it("开关开启且本机文件树有浏览器端口时单击进浏览器", () => {
    expect(
      shouldOpenWorkspaceFileTreeHtmlInBrowser({
        row: htmlFile,
        htmlClickOpensBrowser: true,
        isRemoteWorkspace: false,
        hasBrowserOpener: true,
      }),
    ).toBe(true);
  });

  it("远程 workspace 不把远端路径交给本机浏览器", () => {
    expect(
      shouldOpenWorkspaceFileTreeHtmlInBrowser({
        row: htmlFile,
        htmlClickOpensBrowser: true,
        isRemoteWorkspace: true,
        hasBrowserOpener: true,
      }),
    ).toBe(false);
  });

  it("平台没有内置浏览器（Web/手机）时回落源码预览", () => {
    expect(
      shouldOpenWorkspaceFileTreeHtmlInBrowser({
        row: htmlFile,
        htmlClickOpensBrowser: true,
        isRemoteWorkspace: false,
        hasBrowserOpener: false,
      }),
    ).toBe(false);
  });

  it("非 HTML 文件不受单击偏好影响", () => {
    expect(
      shouldOpenWorkspaceFileTreeHtmlInBrowser({
        row: markdownFile,
        htmlClickOpensBrowser: true,
        isRemoteWorkspace: false,
        hasBrowserOpener: true,
      }),
    ).toBe(false);
  });
});

describe("文件管理器两栏同时折叠为 0 的恢复（A4-06）", () => {
  it("容器回到可用宽度且两栏仍为 0 时重挂载分组", () => {
    expect(
      shouldResetFileManagerLayout({
        containerWidthPx: 320,
        previewSizePercentage: 0,
        directorySizePercentage: 0,
      }),
    ).toBe(true);
  });

  it("容器仍然过窄时不重挂载（避免抖动）", () => {
    expect(
      shouldResetFileManagerLayout({
        containerWidthPx: 79,
        previewSizePercentage: 0,
        directorySizePercentage: 0,
      }),
    ).toBe(false);
  });

  it("只有一栏为 0 是正常收起，不重挂载", () => {
    expect(
      shouldResetFileManagerLayout({
        containerWidthPx: 800,
        previewSizePercentage: 0,
        directorySizePercentage: 100,
      }),
    ).toBe(false);
    expect(
      shouldResetFileManagerLayout({
        containerWidthPx: 800,
        previewSizePercentage: 100,
        directorySizePercentage: 0,
      }),
    ).toBe(false);
  });

  it("两栏都有宽度时不重挂载", () => {
    expect(
      shouldResetFileManagerLayout({
        containerWidthPx: 800,
        previewSizePercentage: 70,
        directorySizePercentage: 30,
      }),
    ).toBe(false);
  });

  it("读取不到面板尺寸（-1 哨兵）时不重挂载", () => {
    expect(
      shouldResetFileManagerLayout({
        containerWidthPx: 800,
        previewSizePercentage: -1,
        directorySizePercentage: -1,
      }),
    ).toBe(false);
  });
});
