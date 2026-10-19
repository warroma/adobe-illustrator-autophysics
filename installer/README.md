# Instalador do AutoPhysics

Mesmo instalador do [AutoGrids](https://github.com/warroma/adobe-illustrator-autogrids) (versão 1.1.x), com o nome e a pasta do painel trocados — a lógica de detecção, instalação e atualização é a mesma.

App Electron com uma tela simples: detecta o Illustrator, copia `com.autophysics.panel` para a pasta de extensões do CEP e habilita o modo de desenvolvimento do CEP automaticamente — os mesmos passos manuais do README principal, só que num clique.

## Status: construído aqui, ainda não testado num Mac/Windows real

Este ambiente de desenvolvimento é Linux, sem Illustrator e sem servidor de display — não dá para abrir a janela do instalador nem gerar o `.dmg`/instalador do Windows aqui. O que foi validado:

- `npm install` resolve corretamente (Electron 44.7.0 + electron-builder 26.15.3).
- Sintaxe de todos os arquivos.
- A lógica "pura" (detecção do Illustrator, cálculo dos caminhos de destino, montagem dos comandos que habilitam o modo de depuração) tem testes próprios em `test/`, com comandos reais do sistema (`defaults`/`reg`) e o sistema de arquivos substituídos por versões falsas — então eles verificam a lógica sem precisar de um Mac/Windows de verdade. Rode `npm test` para conferir.
- Atualização: os cenários (instalar, atualizar, reinstalar, voltar versão, pasta ligada ao código-fonte, troca que falha no meio) são testados com pastas reais criadas no temporário do sistema, e, no instalador do AutoGrids de onde este veio, a detecção foi conferida num Windows 11 real com o Illustrator 2026 instalado fora de Program Files. A janela em si foi conferida no navegador com respostas simuladas.

O que **não** foi testado e só um Mac/Windows reais confirmam: se o Electron abre a janela normalmente, se os caminhos de detecção (`/Applications`, `%ProgramFiles%\Adobe`) batem com uma instalação real do Illustrator, se `defaults`/`reg.exe` têm permissão para escrever sem elevar privilégios, e se o `.dmg`/instalador `.exe` gerado pelo `electron-builder` realmente abre nessas máquinas.

**Sem assinatura digital:** por decisão explícita (custaria uma conta de desenvolvedor Apple + certificado de assinatura Windows), o instalador não é assinado. Isso significa que o Gatekeeper do Mac e o SmartScreen do Windows vão mostrar avisos de "aplicativo não identificado" — veja "Avisos de segurança esperados" mais abaixo.

## Testar a lógica (sem abrir a janela)

```bash
cd installer
npm install
npm test
```

## Rodar em modo de desenvolvimento (precisa de Mac ou Windows com interface gráfica)

```bash
cd installer
npm install
npm start
```

## Gerar o instalador final

```bash
cd installer
npm install
npm run dist
```

Gera em `installer/dist/` o `AutoPhysics-Instalador-Windows.exe` — um executável único, sem etapa de instalação própria: abre direto a janela com o botão de instalar — ou o `AutoPhysics-Instalador-macOS.dmg` (universal, Intel e Apple Silicon). **Rode na própria plataforma de destino**: o `electron-builder` só gera `.dmg` no macOS.

Para publicar, não é preciso gerar nada à mão: empurrar uma tag `vX.Y.Z` dispara o workflow [`release.yml`](../.github/workflows/release.yml), que gera os dois arquivos em máquinas Windows e macOS do GitHub, roda os testes e publica a release com as notas de `docs/release-notes/vX.Y.Z.md`.

## Avisos de segurança esperados (sem assinatura)

- **macOS:** ao abrir o `.dmg`/app pela primeira vez, o Gatekeeper bloqueia com "não é possível abrir porque é de um desenvolvedor não identificado". Solução: clique com o botão direito no app → **Abrir** → confirmar no diálogo (só precisa fazer isso uma vez).
- **Windows:** o SmartScreen mostra "O Windows protegeu seu PC". Solução: clique em **Mais informações** → **Executar assim mesmo**.

## O que o instalador faz, exatamente

1. Procura o Illustrator: pastas com "Adobe Illustrator" no nome em `/Applications` (Mac) ou `Adobe` dentro de `Program Files`/`Program Files (x86)` (Windows) e, no Windows, também o registro de programas instalados — o Creative Cloud deixa instalar em outra unidade (ex.: `D:\Programas\Adobe\...`), que a varredura de pastas não acha. É só para mostrar o que encontrou; não bloqueia a instalação.
2. Confere o que já está instalado e escolhe o cenário (versão = `ExtensionBundleVersion` do `CSXS/manifest.xml`):

   | Situação | O que a tela oferece |
   |---|---|
   | Nada instalado | **Instalar** |
   | Versão instalada mais antiga | **Atualizar** (mostra "1.0.0 → 1.1.0") |
   | Mesma versão | **Reinstalar** |
   | Versão instalada mais nova | **Voltar para a versão X** (pede confirmação) |
   | A pasta instalada é um atalho (symlink/junction) para o código-fonte | **Instalar**: troca o atalho por uma cópia desta versão — só o atalho é removido, os arquivos-fonte não mudam |

   Também verifica se o Illustrator está aberto (`tasklist` / `pgrep`) e avisa antes de instalar.
3. Coloca a pasta `com.autophysics.panel` (a mesma da raiz do repositório, empacotada dentro do instalador) em:
   - Mac: `~/Library/Application Support/Adobe/CEP/extensions/`
   - Windows: `%APPDATA%\Adobe\CEP\extensions\`

   Numa atualização a pasta inteira é trocada, não copiada por cima — assim não sobram arquivos que a versão nova não tem mais. A versão nova é montada ao lado (`com.autophysics.panel.novo`) e só então troca de lugar com a antiga; se a troca falhar (ex.: arquivo preso pelo Illustrator aberto), a versão anterior volta para o lugar. Se a pasta antiga era um atalho para o código-fonte, é o atalho que sai do lugar e é apagado (nunca o conteúdo para onde ele aponta); se a troca falhar, o atalho volta.
4. Habilita `PlayerDebugMode` para `CSXS.7` até `CSXS.12` (via `defaults write` no Mac, `reg add` no Windows) — o mesmo intervalo de versões do passo manual no README principal.
5. No fim, **sempre** pede para fechar o Illustrator por completo e abrir de novo — ele só carrega uma extensão CEP nova ou atualizada ao abrir. Se o Illustrator ainda estiver aberto nesse momento, o aviso fica mais direto ("até lá ele continua usando a versão anterior").

Se o Illustrator mais novo encontrado for anterior ao 2020, a tela avisa que o painel não abre nessa versão (ele usa `PageItem.uuid`, do Illustrator 24.0 em diante) — sem bloquear a instalação.

O `npm test` também roda os testes do painel (`../test/`), já que o instalador o empacota: um motor de física quebrado não chega numa release.

## Estrutura

```
installer/
├── package.json
├── src/
│   ├── main.js       (processo principal do Electron)
│   ├── preload.js    (ponte segura entre main e a janela)
│   ├── detect.js      (lógica pura: achar instalações do Illustrator)
│   ├── install.js      (lógica pura: copiar arquivos, habilitar modo de depuração)
│   └── renderer/       (a janela em si: HTML/CSS/JS comum)
└── test/                (testes de detect.js/install.js, sem precisar do Electron rodando)
```
