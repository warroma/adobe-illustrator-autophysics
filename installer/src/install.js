// Lógica pura de instalação (copiar arquivos, habilitar modo de depuração do
// CEP) — sem nada do Electron aqui, para poder ser testada isoladamente.
"use strict";

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;
var cepExtensionsDir = require("./detect").cepExtensionsDir;
var inspectInstalled = require("./detect").inspectInstalled;

// Mesmo intervalo de versões do CSXS que o README já documenta para o passo manual.
var CSXS_VERSIONS = ["7", "8", "9", "10", "11", "12"];

// runner é injetável só para teste (evita chamar defaults/reg de verdade fora
// do Mac/Windows reais); em produção é sempre child_process.execFileSync.
function enableDebugMode(platform, log, runner) {
    platform = platform || process.platform;
    runner = runner || execFileSync;
    var results = [];
    CSXS_VERSIONS.forEach(function (v) {
        var entry = { version: v, ok: false, error: null };
        try {
            if (platform === "darwin") {
                runner("defaults", ["write", "com.adobe.CSXS." + v, "PlayerDebugMode", "1"]);
            } else if (platform === "win32") {
                runner("reg", ["add", "HKCU\\Software\\Adobe\\CSXS." + v, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]);
            } else {
                throw new Error("Plataforma não suportada: " + platform);
            }
            entry.ok = true;
        } catch (err) {
            entry.error = err.message;
        }
        results.push(entry);
        if (log) log("CSXS." + v + ": " + (entry.ok ? "ok" : "falhou (" + entry.error + ")"));
    });
    return results;
}

// Apaga o que estiver em p, se existir. Um atalho (symlink/junction) sai
// sozinho, sem tocar no alvo: um rmSync recursivo nele poderia seguir o
// atalho e apagar os arquivos-fonte para onde ele aponta.
function removePath(p, fsImpl) {
    var st;
    try {
        st = fsImpl.lstatSync(p);
    } catch (e) {
        return;
    }
    if (!st.isSymbolicLink()) {
        fsImpl.rmSync(p, { recursive: true, force: true });
        return;
    }
    try {
        fsImpl.unlinkSync(p);
    } catch (errUnlink) {
        // Windows: conforme a versão do Node, uma junction só sai com rmdir —
        // que também remove só o atalho, nunca o conteúdo do alvo.
        fsImpl.rmdirSync(p);
    }
}

// Coloca a pasta da extensão (com.autophysics.panel) na pasta de extensões do
// CEP do usuário — serve tanto para instalar quanto para atualizar.
//
// Atualização = troca da pasta inteira, não cópia por cima: copiar por cima
// deixaria para trás arquivos que a versão nova não tem mais. A versão nova é
// montada ao lado ("<pasta>.novo") e só depois troca de lugar com a antiga; se
// a troca falhar no meio (arquivo preso pelo Illustrator aberto, por exemplo),
// a antiga volta para o lugar.
//
// Se o destino é um atalho (symlink/junction para o código-fonte, usado para
// desenvolver o painel), o atalho é trocado pela cópia do mesmo jeito: renomear
// move só o atalho, e ele é apagado com removePath — os arquivos-fonte para
// onde ele aponta nunca são alterados.
//
// fsImpl é injetável só para teste.
function installPanel(panelSourceDir, platform, env, log, fsImpl) {
    fsImpl = fsImpl || fs;
    var destRoot = cepExtensionsDir(platform, env);
    fsImpl.mkdirSync(destRoot, { recursive: true });
    var dest = path.join(destRoot, path.basename(panelSourceDir));
    var installed = inspectInstalled(dest, fsImpl);

    var staging = dest + ".novo";
    var backup = dest + ".antigo";
    removePath(staging, fsImpl);
    removePath(backup, fsImpl);

    if (log) log("Copiando " + panelSourceDir + " -> " + staging);
    fsImpl.cpSync(panelSourceDir, staging, { recursive: true });

    if (installed.exists) {
        if (installed.isLink) {
            if (log) log("Trocando o atalho para " + (installed.linkTarget || "o código-fonte") + " pela cópia instalada (os arquivos de lá não são alterados)");
        } else {
            if (log) log("Substituindo a versão instalada (" + (installed.version || "versão desconhecida") + ")");
        }
        try {
            fsImpl.renameSync(dest, backup);
        } catch (errMove) {
            fsImpl.rmSync(staging, { recursive: true, force: true });
            throw errMove;
        }
        try {
            fsImpl.renameSync(staging, dest);
        } catch (errSwap) {
            fsImpl.renameSync(backup, dest);
            fsImpl.rmSync(staging, { recursive: true, force: true });
            throw errSwap;
        }
        removePath(backup, fsImpl);
    } else {
        fsImpl.renameSync(staging, dest);
    }
    if (log) log("Painel em " + dest);
    return { dest: dest, replacedLink: installed.isLink, previousVersion: installed.version };
}

// macOS: o que vem de um download (o .dmg do instalador) carrega o atributo de
// "quarentena", e ele pode passar para os arquivos copiados — com ele, o CEP
// pode não listar o painel ou abri-lo em branco. É o mesmo `xattr -cr` que o
// README manda rodar na instalação manual. Nas outras plataformas não faz nada.
// runner é injetável só para teste.
function clearQuarantine(dest, platform, log, runner) {
    platform = platform || process.platform;
    if (platform !== "darwin") return true;
    runner = runner || execFileSync;
    try {
        runner("xattr", ["-cr", dest]);
        if (log) log("Quarentena do macOS removida de " + dest);
        return true;
    } catch (err) {
        if (log) log("Aviso: não deu para remover a quarentena do macOS (" + err.message + ")");
        return false;
    }
}

module.exports = {
    CSXS_VERSIONS: CSXS_VERSIONS,
    enableDebugMode: enableDebugMode,
    installPanel: installPanel,
    clearQuarantine: clearQuarantine
};
