// Lógica pura de detecção do Illustrator — sem nada do Electron aqui, só
// fs/path, para poder ser testada isoladamente (ver installer/test/).
"use strict";

var fs = require("fs");
var path = require("path");

function illustratorSearchRoots(platform, env) {
    env = env || process.env;
    if (platform === "darwin") {
        return ["/Applications"];
    }
    if (platform === "win32") {
        var roots = [];
        if (env["ProgramFiles"]) roots.push(path.join(env["ProgramFiles"], "Adobe"));
        if (env["ProgramFiles(x86)"]) roots.push(path.join(env["ProgramFiles(x86)"], "Adobe"));
        if (roots.length === 0) roots.push("C:\\Program Files\\Adobe");
        return roots;
    }
    return [];
}

function extractYear(name) {
    var m = name.match(/(20\d{2})/);
    return m ? parseInt(m[1], 10) : 0;
}

// Varre uma lista explícita de pastas-raiz procurando subpastas cujo nome
// contenha "adobe illustrator" (case-insensitive). Separado de
// findIllustratorInstalls para poder testar com raízes fake, sem depender de
// /Applications ou %ProgramFiles% existirem de verdade nesta máquina.
function scanRootsForIllustrator(roots) {
    var found = [];
    roots.forEach(function (root) {
        var entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch (e) {
            return; // pasta não existe nesta máquina — segue para a próxima raiz
        }
        entries.forEach(function (entry) {
            if (!entry.isDirectory()) return;
            if (!/adobe illustrator/i.test(entry.name)) return;
            found.push({ name: entry.name, path: path.join(root, entry.name), year: extractYear(entry.name) });
        });
    });
    found.sort(function (a, b) { return b.year - a.year; });
    return found;
}

var UNINSTALL_KEYS = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];

// Windows: o Creative Cloud deixa o Illustrator instalar em qualquer unidade
// (ex.: D:\Programas\Adobe\...), fora de Program Files — aí a varredura de
// pastas não acha. O registro de "Programas instalados" sempre tem o caminho
// real (InstallLocation). runner é injetável só para teste.
function findIllustratorInRegistry(runner) {
    runner = runner || require("child_process").execFileSync;
    var entries = [];
    UNINSTALL_KEYS.forEach(function (key) {
        var out;
        try {
            out = String(runner("reg", ["query", key, "/s", "/f", "Illustrator", "/d"]));
        } catch (e) {
            return; // reg sai com código 1 quando não acha nada nessa chave
        }
        var current = null;
        out.split(/\r?\n/).forEach(function (line) {
            if (/^HKEY_/.test(line)) {
                current = {};
                entries.push(current);
                return;
            }
            var m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
            if (m && current) current[m[1]] = m[2].trim();
        });
    });
    return entries
        .filter(function (e) { return /adobe illustrator/i.test(e.DisplayName || "") && e.InstallLocation; })
        .map(function (e) { return { name: e.DisplayName, path: e.InstallLocation, year: extractYear(e.DisplayName) }; });
}

function findIllustratorInstalls(platform, env, runner) {
    platform = platform || process.platform;
    var found = scanRootsForIllustrator(illustratorSearchRoots(platform, env));
    if (platform === "win32") {
        var seen = {};
        found.forEach(function (f) { seen[f.path.toLowerCase()] = true; });
        findIllustratorInRegistry(runner).forEach(function (f) {
            if (seen[f.path.toLowerCase()]) return;
            seen[f.path.toLowerCase()] = true;
            found.push(f);
        });
        found.sort(function (a, b) { return b.year - a.year; });
    }
    return found;
}

function cepExtensionsDir(platform, env) {
    platform = platform || process.platform;
    env = env || process.env;
    if (platform === "darwin") {
        return path.join(env.HOME, "Library", "Application Support", "Adobe", "CEP", "extensions");
    }
    if (platform === "win32") {
        return path.join(env.APPDATA, "Adobe", "CEP", "extensions");
    }
    throw new Error("Plataforma não suportada para o instalador do AutoPhysics: " + platform);
}

// Versão gravada no manifest do painel (ExtensionBundleVersion), ou null se a
// pasta não tiver um manifest legível.
function readPanelVersion(panelDir, fsImpl) {
    fsImpl = fsImpl || fs;
    try {
        var xml = fsImpl.readFileSync(path.join(panelDir, "CSXS", "manifest.xml"), "utf8");
        var m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

// -1, 0 ou 1 comparando "1.2.10" com "1.10.0" número a número.
function compareVersions(a, b) {
    var pa = String(a).split(".");
    var pb = String(b).split(".");
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var x = parseInt(pa[i] || "0", 10) || 0;
        var y = parseInt(pb[i] || "0", 10) || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

// O que já existe no destino. "isLink" = a pasta é um atalho (symlink no Mac,
// junction no Windows) — é como se trabalha no próprio repositório: o
// Illustrator lê direto dos arquivos-fonte. Instalar troca o atalho por uma
// cópia sem alterar esses arquivos (ver install.installPanel).
function inspectInstalled(dest, fsImpl) {
    fsImpl = fsImpl || fs;
    var info = { exists: false, isLink: false, linkTarget: null, version: null };
    var st;
    try {
        st = fsImpl.lstatSync(dest);
    } catch (e) {
        return info;
    }
    info.exists = true;
    if (st.isSymbolicLink()) {
        info.isLink = true;
        try { info.linkTarget = fsImpl.readlinkSync(dest); } catch (e2) { /* alvo ilegível */ }
    }
    info.version = readPanelVersion(dest, fsImpl);
    return info;
}

// Qual cenário a tela de verificação deve mostrar:
//   install   — nada instalado ainda
//   update    — instalada uma versão mais antiga (ou sem versão legível)
//   reinstall — a mesma versão já está instalada
//   downgrade — a instalada é MAIS NOVA que a deste instalador
//   linked    — a pasta é um atalho para o código-fonte; instalar troca o
//               atalho pela cópia desta versão
function planInstall(installed, bundledVersion) {
    if (!installed.exists) return "install";
    if (installed.isLink) return "linked";
    if (!installed.version || !bundledVersion) return "update";
    var c = compareVersions(installed.version, bundledVersion);
    if (c < 0) return "update";
    if (c === 0) return "reinstall";
    return "downgrade";
}

// true/false se deu para saber, null se não deu (plataforma sem suporte ou o
// comando falhou por outro motivo). O Illustrator só carrega uma extensão CEP
// nova ou atualizada ao ser aberto, então isso decide o tom do aviso final.
// runner é injetável só para teste.
function isIllustratorRunning(platform, runner) {
    platform = platform || process.platform;
    runner = runner || require("child_process").execFileSync;
    try {
        if (platform === "win32") {
            var out = String(runner("tasklist", ["/FI", "IMAGENAME eq Illustrator.exe", "/NH", "/FO", "CSV"]));
            return /"Illustrator\.exe"/i.test(out);
        }
        if (platform === "darwin") {
            // pgrep sai com código 1 (exceção no execFileSync) quando não acha nada.
            try {
                runner("pgrep", ["-x", "Adobe Illustrator"]);
                return true;
            } catch (notFound) {
                if (notFound && notFound.status === 1) return false;
                throw notFound;
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

module.exports = {
    illustratorSearchRoots: illustratorSearchRoots,
    extractYear: extractYear,
    scanRootsForIllustrator: scanRootsForIllustrator,
    findIllustratorInRegistry: findIllustratorInRegistry,
    findIllustratorInstalls: findIllustratorInstalls,
    cepExtensionsDir: cepExtensionsDir,
    readPanelVersion: readPanelVersion,
    compareVersions: compareVersions,
    inspectInstalled: inspectInstalled,
    planInstall: planInstall,
    isIllustratorRunning: isIllustratorRunning
};
