"use strict";

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var detect = require("../src/detect");

// Pastas falsas criadas na hora, no temporário do sistema — os testes não
// dependem de nenhuma pasta existir antes nesta máquina.
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), "autophysics-detect-"));
function mkdirs(root, names) {
    names.forEach(function (n) { fs.mkdirSync(path.join(root, n), { recursive: true }); });
    return root;
}
var FAKE_MAC_ROOT = mkdirs(path.join(TMP, "Applications"), ["Adobe Illustrator 2024", "Adobe Illustrator 2026", "Some Other App"]);
var FAKE_WIN_ADOBE_ROOT = mkdirs(path.join(TMP, "Program Files", "Adobe"), ["Adobe Illustrator 2025", "Adobe Photoshop 2025"]);
function writePanel(dir, version) {
    fs.mkdirSync(path.join(dir, "CSXS"), { recursive: true });
    fs.writeFileSync(path.join(dir, "CSXS", "manifest.xml"),
        '<ExtensionManifest Version="7.0" ExtensionBundleId="com.autophysics.panel" ExtensionBundleVersion="' + version + '"></ExtensionManifest>');
    return dir;
}

try {
    // ---- extractYear ----
    assert.strictEqual(detect.extractYear("Adobe Illustrator 2026"), 2026);
    assert.strictEqual(detect.extractYear("Adobe Illustrator CC"), 0);
    assert.strictEqual(detect.extractYear(""), 0);
    console.log("extractYear: OK");

    // ---- scanRootsForIllustrator: finds installs, ignores unrelated folders, sorts newest-first ----
    var found = detect.scanRootsForIllustrator([FAKE_MAC_ROOT]);
    assert.strictEqual(found.length, 2, "expected exactly 2 fake Illustrator installs, got " + found.length);
    assert.strictEqual(found[0].name, "Adobe Illustrator 2026", "expected newest first");
    assert.strictEqual(found[1].name, "Adobe Illustrator 2024");
    assert.ok(!found.some(function (f) { return f.name === "Some Other App"; }), "unrelated folder leaked into results");
    assert.strictEqual(found[0].path, path.join(FAKE_MAC_ROOT, "Adobe Illustrator 2026"));
    console.log("scanRootsForIllustrator (mac-style root): OK —", found.map(function (f) { return f.name; }));

    // ---- scanRootsForIllustrator: a root that doesn't exist on this machine must not throw ----
    var emptyResult = detect.scanRootsForIllustrator([path.join(TMP, "does-not-exist")]);
    assert.deepStrictEqual(emptyResult, [], "a missing root should yield an empty array, not throw");
    console.log("scanRootsForIllustrator (missing root): OK, returns [] without throwing");

    // ---- scanRootsForIllustrator: multiple roots combined (simulates Program Files + Program Files (x86)) ----
    var combined = detect.scanRootsForIllustrator([FAKE_WIN_ADOBE_ROOT, path.join(TMP, "also-missing")]);
    assert.strictEqual(combined.length, 1);
    assert.strictEqual(combined[0].name, "Adobe Illustrator 2025");
    console.log("scanRootsForIllustrator (multiple roots, one missing): OK");

    // ---- findIllustratorInRegistry: parses `reg query` output (install outside Program Files) ----
    var REG_OUT = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ILST_30_8_2\r\n" +
        "    DisplayName    REG_SZ    Adobe Illustrator 2026\r\n" +
        "    DisplayIcon    REG_SZ    E:\\Apps\\Adobe\\Adobe Illustrator 2026\\Support Files\\Contents\\Windows\\AI_Application_Icon.ico\r\n" +
        "    InstallLocation    REG_SZ    E:\\Apps\\Adobe\\Adobe Illustrator 2026\r\n\r\n" +
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SomePlugin\r\n" +
        "    DisplayName    REG_SZ    Plugin para Illustrator\r\n\r\nFim da pesquisa: 2 correspondência(s) encontrada(s).\r\n";
    var regRunner = function (cmd, args) {
        if (args[1].indexOf("WOW6432Node") >= 0) return REG_OUT;
        var e = new Error("nada encontrado"); e.status = 1; throw e;
    };
    var fromReg = detect.findIllustratorInRegistry(regRunner);
    assert.deepStrictEqual(fromReg, [{ name: "Adobe Illustrator 2026", path: "E:\\Apps\\Adobe\\Adobe Illustrator 2026", year: 2026 }]);
    var merged = detect.findIllustratorInstalls("win32", { "ProgramFiles": path.join(TMP, "Program Files") }, regRunner);
    assert.deepStrictEqual(merged.map(function (f) { return f.name; }), ["Adobe Illustrator 2026", "Adobe Illustrator 2025"], "registry + folder scan, newest first");
    console.log("findIllustratorInRegistry: OK (finds install on another drive, ignores non-Illustrator entries, merges with folder scan)");

    // ---- illustratorSearchRoots: platform-specific root selection ----
    assert.deepStrictEqual(detect.illustratorSearchRoots("darwin", {}), ["/Applications"]);
    var win32BothVars = detect.illustratorSearchRoots("win32", { "ProgramFiles": "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" });
    assert.deepStrictEqual(win32BothVars, [
        path.join("C:\\Program Files", "Adobe"),
        path.join("C:\\Program Files (x86)", "Adobe")
    ]);
    assert.deepStrictEqual(detect.illustratorSearchRoots("win32", {}), ["C:\\Program Files\\Adobe"], "should fall back to a sane default when env vars are absent");
    assert.deepStrictEqual(detect.illustratorSearchRoots("linux", {}), [], "unsupported platform should yield no roots, not throw");
    console.log("illustratorSearchRoots: OK (darwin, win32 with/without env vars, unsupported platform)");

    // ---- cepExtensionsDir ----
    assert.strictEqual(
        detect.cepExtensionsDir("darwin", { HOME: "/Users/test" }),
        path.join("/Users/test", "Library", "Application Support", "Adobe", "CEP", "extensions")
    );
    assert.strictEqual(
        detect.cepExtensionsDir("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }),
        path.join("C:\\Users\\test\\AppData\\Roaming", "Adobe", "CEP", "extensions")
    );
    assert.throws(function () { detect.cepExtensionsDir("linux", {}); }, /não suportada/);
    console.log("cepExtensionsDir: OK (darwin, win32, unsupported platform throws)");

    // ---- readPanelVersion ----
    assert.strictEqual(detect.readPanelVersion(writePanel(path.join(TMP, "panel-110"), "1.1.0")), "1.1.0");
    assert.strictEqual(detect.readPanelVersion(path.join(TMP, "no-panel-here")), null);
    console.log("readPanelVersion: OK (reads ExtensionBundleVersion, null without manifest)");

    // ---- compareVersions ----
    assert.strictEqual(detect.compareVersions("1.0.0", "1.1.0"), -1);
    assert.strictEqual(detect.compareVersions("1.10.0", "1.9.9"), 1, "numeric, not lexicographic");
    assert.strictEqual(detect.compareVersions("1.1", "1.1.0"), 0);
    console.log("compareVersions: OK");

    // ---- inspectInstalled: missing / real folder / link ----
    assert.deepStrictEqual(detect.inspectInstalled(path.join(TMP, "nothing")), { exists: false, isLink: false, linkTarget: null, version: null });
    var realDir = writePanel(path.join(TMP, "installed-real"), "1.0.0");
    var real = detect.inspectInstalled(realDir);
    assert.strictEqual(real.exists, true);
    assert.strictEqual(real.isLink, false);
    assert.strictEqual(real.version, "1.0.0");
    var linkDir = path.join(TMP, "installed-link");
    fs.symlinkSync(realDir, linkDir, "junction");
    var linked = detect.inspectInstalled(linkDir);
    assert.strictEqual(linked.isLink, true, "a symlink/junction to the source must be reported as a link");
    assert.strictEqual(linked.version, "1.0.0");
    console.log("inspectInstalled: OK (missing, real folder, link)");

    // ---- planInstall: each scenario ----
    assert.strictEqual(detect.planInstall({ exists: false }, "1.1.0"), "install");
    assert.strictEqual(detect.planInstall({ exists: true, isLink: true, version: "1.1.0" }, "1.1.0"), "linked");
    assert.strictEqual(detect.planInstall({ exists: true, isLink: false, version: "1.0.0" }, "1.1.0"), "update");
    assert.strictEqual(detect.planInstall({ exists: true, isLink: false, version: null }, "1.1.0"), "update", "unreadable version is treated as an update");
    assert.strictEqual(detect.planInstall({ exists: true, isLink: false, version: "1.1.0" }, "1.1.0"), "reinstall");
    assert.strictEqual(detect.planInstall({ exists: true, isLink: false, version: "2.0.0" }, "1.1.0"), "downgrade");
    console.log("planInstall: OK (install, linked, update, reinstall, downgrade)");

    // ---- isIllustratorRunning: parses tasklist / pgrep via a fake runner ----
    assert.strictEqual(detect.isIllustratorRunning("win32", function () { return '"Illustrator.exe","30724","Console","1","1.234.567 K"\r\n'; }), true);
    assert.strictEqual(detect.isIllustratorRunning("win32", function () { return "INFO: No tasks are running which match the specified criteria.\r\n"; }), false);
    assert.strictEqual(detect.isIllustratorRunning("darwin", function () { return "123\n"; }), true);
    assert.strictEqual(detect.isIllustratorRunning("darwin", function () { var e = new Error("exit 1"); e.status = 1; throw e; }), false);
    assert.strictEqual(detect.isIllustratorRunning("win32", function () { throw new Error("tasklist missing"); }), null, "unknown, not a false negative");
    assert.strictEqual(detect.isIllustratorRunning("linux", function () { return ""; }), null);
    console.log("isIllustratorRunning: OK (win32/darwin found + not found, failures -> null)");

    console.log("ALL detect.js CHECKS PASSED");
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}
