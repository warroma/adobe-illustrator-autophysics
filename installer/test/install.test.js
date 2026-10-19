"use strict";

var assert = require("assert");
var path = require("path");
var install = require("../src/install");

// ---- enableDebugMode: calls the right command once per CSXS version, on each platform ----
function testEnableDebugMode(platform, expectedCmd) {
    var calls = [];
    var fakeRunner = function (cmd, args) {
        calls.push({ cmd: cmd, args: args });
    };
    var logLines = [];
    var results = install.enableDebugMode(platform, function (l) { logLines.push(l); }, fakeRunner);

    assert.strictEqual(calls.length, install.CSXS_VERSIONS.length, platform + ": expected one call per CSXS version");
    assert.strictEqual(results.length, install.CSXS_VERSIONS.length);
    results.forEach(function (r) { assert.strictEqual(r.ok, true, platform + ": expected ok:true when the runner does not throw"); });
    calls.forEach(function (c, i) {
        assert.strictEqual(c.cmd, expectedCmd, platform + ": wrong command");
        assert.ok(c.args.indexOf("CSXS." + install.CSXS_VERSIONS[i]) >= 0 || c.args.join(" ").indexOf("CSXS." + install.CSXS_VERSIONS[i]) >= 0, platform + ": CSXS version missing from args: " + JSON.stringify(c.args));
        assert.ok(c.args.join(" ").indexOf("PlayerDebugMode") >= 0, platform + ": PlayerDebugMode missing from args");
    });
    assert.strictEqual(logLines.length, install.CSXS_VERSIONS.length, "expected one log line per version");
    console.log("enableDebugMode(" + platform + "): OK —", calls.length, "calls to " + expectedCmd);
}
testEnableDebugMode("darwin", "defaults");
testEnableDebugMode("win32", "reg");

// ---- enableDebugMode: a failing call is captured per-entry, not thrown ----
(function () {
    var callCount = 0;
    var flakyRunner = function () {
        callCount++;
        if (callCount === 2) throw new Error("boom");
    };
    var results = install.enableDebugMode("darwin", null, flakyRunner);
    assert.strictEqual(results.length, install.CSXS_VERSIONS.length);
    assert.strictEqual(results[1].ok, false, "the failing call should be marked ok:false");
    assert.strictEqual(results[1].error, "boom");
    assert.strictEqual(results[0].ok, true, "other calls should still succeed independently");
    assert.strictEqual(results[2].ok, true);
    console.log("enableDebugMode: a single failing CSXS version does not abort the rest — OK");
})();

// ---- enableDebugMode: unsupported platform fails every entry with a message, does not throw ----
(function () {
    var results = install.enableDebugMode("linux", null, function () { throw new Error("should never be called"); });
    assert.strictEqual(results.length, install.CSXS_VERSIONS.length);
    results.forEach(function (r) {
        assert.strictEqual(r.ok, false);
        assert.ok(/não suportada/.test(r.error));
    });
    console.log("enableDebugMode(linux/unsupported): OK, fails gracefully per entry");
})();

// ---- clearQuarantine: runs `xattr -cr <dest>` only on macOS, never throws ----
(function () {
    var calls = [];
    var runner = function (cmd, args) { calls.push([cmd].concat(args).join(" ")); };
    assert.strictEqual(install.clearQuarantine("/x/com.autophysics.panel", "darwin", null, runner), true);
    assert.deepStrictEqual(calls, ["xattr -cr /x/com.autophysics.panel"]);
    assert.strictEqual(install.clearQuarantine("C:\\x", "win32", null, runner), true);
    assert.strictEqual(calls.length, 1, "must not run anything outside macOS");
    assert.strictEqual(install.clearQuarantine("/x", "darwin", null, function () { throw new Error("sem xattr"); }), false);
    console.log("clearQuarantine: OK (macOS runs xattr -cr, other platforms no-op, failure reported not thrown)");
})();

// ---- installPanel: real folders in a temp dir (fresh install, update, dev link, failed swap) ----
var fs = require("fs");
var os = require("os");
var detect = require("../src/detect");
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), "autophysics-install-"));
function writePanel(dir, version, extraFile) {
    fs.mkdirSync(path.join(dir, "CSXS"), { recursive: true });
    fs.writeFileSync(path.join(dir, "CSXS", "manifest.xml"),
        '<ExtensionManifest ExtensionBundleId="com.autophysics.panel" ExtensionBundleVersion="' + version + '"></ExtensionManifest>');
    if (extraFile) fs.writeFileSync(path.join(dir, extraFile), extraFile);
    return dir;
}
function leftovers(dest) {
    return [dest + ".novo", dest + ".antigo"].filter(function (p) { return fs.existsSync(p); });
}

try {
    var source = writePanel(path.join(TMP, "bundle", "com.autophysics.panel"), "1.1.0", "novo.txt");

    // fresh install
    (function () {
        var env = { APPDATA: path.join(TMP, "fresh") };
        var logLines = [];
        var r = install.installPanel(source, "win32", env, function (l) { logLines.push(l); });
        var expected = path.join(env.APPDATA, "Adobe", "CEP", "extensions", "com.autophysics.panel");
        assert.strictEqual(r.dest, expected);
        assert.strictEqual(r.replacedLink, false);
        assert.strictEqual(r.previousVersion, null);
        assert.strictEqual(detect.readPanelVersion(r.dest), "1.1.0");
        assert.ok(fs.existsSync(path.join(r.dest, "novo.txt")));
        assert.deepStrictEqual(leftovers(r.dest), [], "no staging/backup folders left behind");
        assert.ok(logLines.length >= 2);
        console.log("installPanel (fresh install): OK —", r.dest);
    })();

    // update: replaces the whole folder, so files the new version dropped do not linger
    (function () {
        var env = { APPDATA: path.join(TMP, "update") };
        var dest = path.join(env.APPDATA, "Adobe", "CEP", "extensions", "com.autophysics.panel");
        writePanel(dest, "1.0.0", "velho.txt");
        var r = install.installPanel(source, "win32", env, null);
        assert.strictEqual(r.previousVersion, "1.0.0");
        assert.strictEqual(detect.readPanelVersion(dest), "1.1.0");
        assert.ok(!fs.existsSync(path.join(dest, "velho.txt")), "stale file from the old version must be gone");
        assert.ok(fs.existsSync(path.join(dest, "novo.txt")));
        assert.deepStrictEqual(leftovers(dest), []);
        console.log("installPanel (update 1.0.0 -> 1.1.0): OK, stale files removed");
    })();

    // dev link: the destination is a junction/symlink to the source code — the link is
    // replaced by a real copy in the same run, and the source folder is left exactly as it was
    function makeDevLink(name) {
        var env = { APPDATA: path.join(TMP, name) };
        var extDir = path.join(env.APPDATA, "Adobe", "CEP", "extensions");
        fs.mkdirSync(extDir, { recursive: true });
        var devSource = writePanel(path.join(TMP, name + "-repo", "com.autophysics.panel"), "1.0.0", "fonte.txt");
        var dest = path.join(extDir, "com.autophysics.panel");
        fs.symlinkSync(devSource, dest, "junction");
        return { env: env, devSource: devSource, dest: dest };
    }
    function assertSourceUntouched(devSource) {
        assert.deepStrictEqual(fs.readdirSync(devSource).sort(), ["CSXS", "fonte.txt"], "source folder must keep exactly its own files");
        assert.strictEqual(detect.readPanelVersion(devSource), "1.0.0", "source code must not be overwritten");
    }

    (function () {
        var d = makeDevLink("linked");
        var r = install.installPanel(source, "win32", d.env, null);
        assert.strictEqual(r.replacedLink, true);
        assert.strictEqual(r.previousVersion, "1.0.0");
        assert.ok(!fs.lstatSync(d.dest).isSymbolicLink(), "the link must be replaced by a real folder");
        assert.strictEqual(detect.readPanelVersion(d.dest), "1.1.0");
        assert.ok(fs.existsSync(path.join(d.dest, "novo.txt")));
        assertSourceUntouched(d.devSource);
        assert.deepStrictEqual(leftovers(d.dest), [], "no staging/backup left behind");
        console.log("installPanel (dev link): OK, link replaced by 1.1.0, source folder untouched");
    })();

    // dev link + failed swap: the link comes back, source still untouched
    (function () {
        var d = makeDevLink("linked-failed");
        var flakyFs = Object.create(fs);
        flakyFs.renameSync = function (from, to) {
            if (from === d.dest + ".novo" && to === d.dest) {
                var e = new Error("EBUSY: resource busy or locked, rename");
                e.code = "EBUSY";
                throw e;
            }
            return fs.renameSync(from, to);
        };
        assert.throws(function () { install.installPanel(source, "win32", d.env, null, flakyFs); }, /EBUSY/);
        assert.ok(fs.lstatSync(d.dest).isSymbolicLink(), "the link must be restored");
        assert.strictEqual(fs.realpathSync(d.dest), fs.realpathSync(d.devSource));
        assertSourceUntouched(d.devSource);
        assert.deepStrictEqual(leftovers(d.dest), []);
        console.log("installPanel (dev link, failed swap): OK, link restored");
    })();

    // a link left behind as ".antigo" by an interrupted run is removed as a link, never followed
    (function () {
        var d = makeDevLink("linked-leftover");
        fs.renameSync(d.dest, d.dest + ".antigo");
        install.installPanel(source, "win32", d.env, null);
        assert.strictEqual(detect.readPanelVersion(d.dest), "1.1.0");
        assertSourceUntouched(d.devSource);
        assert.deepStrictEqual(leftovers(d.dest), []);
        console.log("installPanel (leftover link from an interrupted run): OK, source folder untouched");
    })();

    // failed swap (e.g. a file held open): the previous version comes back
    (function () {
        var env = { APPDATA: path.join(TMP, "failed") };
        var dest = path.join(env.APPDATA, "Adobe", "CEP", "extensions", "com.autophysics.panel");
        writePanel(dest, "1.0.0", "velho.txt");
        var flakyFs = Object.create(fs);
        flakyFs.renameSync = function (from, to) {
            if (from === dest + ".novo" && to === dest) {
                var e = new Error("EBUSY: resource busy or locked, rename");
                e.code = "EBUSY";
                throw e;
            }
            return fs.renameSync(from, to);
        };
        assert.throws(function () { install.installPanel(source, "win32", env, null, flakyFs); }, /EBUSY/);
        assert.strictEqual(detect.readPanelVersion(dest), "1.0.0", "old version must be restored");
        assert.ok(fs.existsSync(path.join(dest, "velho.txt")));
        assert.deepStrictEqual(leftovers(dest), [], "no staging/backup folders left behind");
        console.log("installPanel (failed swap): OK, previous version restored");
    })();
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("ALL install.js CHECKS PASSED");
