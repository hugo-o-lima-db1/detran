#!/usr/bin/env bash
# ============================================================================
#  Instalador ONE-SHOT da automação de agendamento do exame psicológico
#  DETRAN-PR (serviço 749) — para rodar 24/7 numa VPS Linux.
#
#  O que este script faz:
#    1. Instala o que falta (Node.js 22, dependências do Chromium)
#    2. Baixa o projeto e instala as dependências + navegador
#    3. Pergunta seu CPF, número do processo e (opcional) Telegram
#    4. Faz um teste imediato para você ver se funciona
#    5. Agenda a verificação automática a cada 2h (systemd) e para sozinho
#       quando conseguir agendar
#
#  Como usar (na sua VPS):
#    bash instalar-vps.sh
#
#  Requisitos: Ubuntu/Debian (ou derivado) com acesso sudo. Não precisa ser root.
# ============================================================================

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/hugo-o-lima-db1/detran.git}"
BRANCH="${BRANCH:-claude/automate-psychology-exam-booking-wwkv2k}"
DIR="${DIR:-$HOME/detran-agendamento}"

azul()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
verde() { printf '\033[1;32m%s\033[0m\n' "$*"; }
amar()  { printf '\033[1;33m%s\033[0m\n' "$*"; }
vermo() { printf '\033[1;31m%s\033[0m\n' "$*"; }

azul "=== Instalador da automação DETRAN-PR (exame psicológico) ==="
echo

# --- 0. Checagens básicas ---------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  amar "Aviso: rodando como root. Funciona, mas o ideal é um usuário normal com sudo."
  SUDO=""
else
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    vermo "Preciso do 'sudo' para instalar pacotes. Instale o sudo ou rode como root."
    exit 1
  fi
fi

# --- 0.2 curl (usado já no teste de rede abaixo) ----------------------------
if ! command -v curl >/dev/null 2>&1; then
  azul "Instalando curl..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y curl
fi

# --- 0.5 Esta máquina alcança o Detran? -------------------------------------
# O portal carrega seu JavaScript de um host que NÃO responde fora do Brasil.
# Testar isso agora evita instalar tudo para descobrir depois que não funciona.
azul "[0/6] Verificando se esta máquina alcança o portal do Detran..."
UA_TEST='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
PORTAL_URL="https://www.agendamento.detran.pr.gov.br/detran-agendamento/portal?servico=749"

# Descobre o nome atual do bundle (o hash muda a cada deploy do Detran).
BUNDLE_PATH="$(curl -sS -A "$UA_TEST" -m 30 "$PORTAL_URL" 2>/dev/null \
  | grep -o 'https://dagf-detran-atendimento-prod\.paas\.pr\.gov\.br/assets/index-[^"]*\.js' \
  | head -1 || true)"
if [ -z "${BUNDLE_PATH:-}" ]; then
  BUNDLE_PATH="https://dagf-detran-atendimento-prod.paas.pr.gov.br/assets/index-cc095a18.js"
fi

BUNDLE_CODE="$(curl -sS -A "$UA_TEST" -H 'Referer: https://www.detran.pr.gov.br/' \
  -m 30 -o /dev/null -w '%{http_code}' "$BUNDLE_PATH" 2>/dev/null || echo "000")"

case "$BUNDLE_CODE" in
  000)
    echo
    vermo "     ✘ Esta máquina NÃO alcança o servidor de aplicação do Detran."
    vermo "       (host dagf-detran-atendimento-prod.paas.pr.gov.br — timeout)"
    echo
    amar  "     Esse host só responde de dentro do Brasil. Se esta VPS está no"
    amar  "     exterior, a automação vai abrir a página em branco e não funcionar."
    echo
    read -r -p "     Continuar mesmo assim? [s/N]: " GO
    case "${GO:-N}" in
      [sS]*) amar "     Ok, seguindo (pode não funcionar)." ;;
      *)     vermo "     Abortado. Use uma VPS hospedada no Brasil."; exit 1 ;;
    esac
    ;;
  *)
    verde "     ✔ Alcança o Detran (bundle respondeu HTTP $BUNDLE_CODE). Rede OK."
    ;;
esac

# --- 1. Node.js 20+ ---------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -ge 20 ]; then need_node=0; fi
fi

if [ "$need_node" -eq 1 ]; then
  azul "[1/6] Instalando Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
else
  verde "[1/6] Node.js $(node -v) já instalado."
fi

# --- 2. git ----------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  azul "[2/6] Instalando git..."
  $SUDO apt-get install -y git
else
  verde "[2/6] git já instalado."
fi

# --- 3. Projeto ------------------------------------------------------------
azul "[3/6] Baixando o projeto em $DIR ..."
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" pull origin "$BRANCH"
else
  # Repositório privado: o git vai pedir usuário/token se necessário.
  git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"

azul "     Instalando dependências do projeto..."
npm install --no-audit --no-fund

azul "     Instalando o navegador Chromium (pode levar 1-2 min)..."
npx playwright install --with-deps chromium

# --- 4. Configuração (.env) ------------------------------------------------
azul "[4/6] Configuração"
if [ -f .env ]; then
  amar "     Já existe um .env. Vou manter o atual."
  amar "     (Se quiser reconfigurar: apague o .env e rode o script de novo.)"
else
  echo
  echo "Informe os MESMOS dados que você digita no portal do Detran para entrar:"
  read -r -p "  CPF (só números): " CPF_IN
  read -r -p "  Número do processo / RENACH: " PROC_IN
  echo
  echo "Notificação por Telegram (opcional — Enter para pular):"
  echo "  Como obter: fale com @BotFather no Telegram, crie um bot e copie o token."
  read -r -p "  TELEGRAM_BOT_TOKEN: " TG_TOKEN
  TG_CHAT=""
  if [ -n "${TG_TOKEN:-}" ]; then
    read -r -p "  TELEGRAM_CHAT_ID: " TG_CHAT
  fi
  echo
  echo "Agendar automaticamente ao encontrar vaga?"
  read -r -p "  [S/n]: " AUTOB
  case "${AUTOB:-S}" in
    [nN]*) AUTO_BOOK_VAL="false" ;;
    *)     AUTO_BOOK_VAL="true"  ;;
  esac
  read -r -p "  Cidade preferida (opcional, ex.: CURITIBA): " CIDADE_IN

  cat > .env <<EOF
# Gerado por deploy/instalar-vps.sh
DETRAN_CPF=${CPF_IN}
DETRAN_PROCESSO=${PROC_IN}
DETRAN_SERVICO=749
AUTO_BOOK=${AUTO_BOOK_VAL}
HEADLESS=true
USER_DATA_DIR=./user-data
STEP_TIMEOUT_MS=60000
CIDADE_PREFERIDA=${CIDADE_IN}
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_CHAT_ID=${TG_CHAT}
EOF
  chmod 600 .env
  verde "     .env criado (permissão 600 — só você lê)."
fi

# --- 5. Teste imediato -----------------------------------------------------
azul "[5/6] Fazendo um teste agora..."
echo "     (Isso abre o portal do Detran e verifica as datas. Aguarde...)"
echo
set +e
npm run check
CODE=$?
set -e
echo
case "$CODE" in
  0) verde "     ✔ Deu certo! Encontrou vaga (ou já agendou). Veja a mensagem acima." ;;
  1) verde "     ✔ Funcionou! Não há vagas neste momento — é o esperado no dia a dia." ;;
  *) amar  "     ⚠ Terminou com código $CODE. Veja a mensagem acima e os arquivos em runs/."
     amar  "       Se falou de CPF/processo, confira o .env. Se foi timeout de rede,"
     amar  "       a VPS não está alcançando o site do Detran." ;;
esac

# --- 6. Agendamento 24/7 (systemd) ----------------------------------------
azul "[6/6] Agendando verificação automática a cada 2 horas..."

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
NPM_BIN="$(command -v npm)"

cat > "$UNIT_DIR/detran-check.service" <<EOF
[Unit]
Description=Verifica vagas do exame psicologico no DETRAN-PR
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${DIR}
ExecStart=${NPM_BIN} run check
# Codigo 1 = "sem vagas hoje": nao e falha de verdade.
SuccessExitStatus=0 1
EOF

cat > "$UNIT_DIR/detran-check.timer" <<'EOF'
[Unit]
Description=Dispara a verificacao de vagas do DETRAN-PR a cada 2 horas

[Timer]
OnBootSec=5min
OnUnitActiveSec=2h
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF

if systemctl --user daemon-reload 2>/dev/null; then
  systemctl --user enable --now detran-check.timer
  # Mantém o timer rodando mesmo com você desconectado do SSH.
  $SUDO loginctl enable-linger "$(id -un)" 2>/dev/null || \
    amar "     (Não consegui habilitar 'linger'. Rode: sudo loginctl enable-linger $(id -un))"
  verde "     ✔ Agendado! Verificando a cada 2 horas, 24/7."
  echo
  echo "     Comandos úteis:"
  echo "       systemctl --user list-timers | grep detran     # ver próxima execução"
  echo "       journalctl --user -u detran-check -n 50        # ver o log"
  echo "       systemctl --user disable --now detran-check.timer   # PARAR (após agendar!)"
else
  amar "     Este sistema não tem systemd de usuário. Usando cron..."
  CRON_LINE="0 */2 * * * cd ${DIR} && ${NPM_BIN} run check >> ${DIR}/runs/cron.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'detran.*npm run check' ; echo "$CRON_LINE" ) | crontab -
  verde "     ✔ Agendado no cron (a cada 2 horas)."
  echo "       crontab -l          # conferir"
  echo "       crontab -e          # editar/remover quando agendar"
fi

echo
verde "=== Pronto! ==="
echo "Projeto em: $DIR"
echo "Quando você receber o aviso de AGENDAMENTO REALIZADO, desligue a automação:"
echo "  systemctl --user disable --now detran-check.timer"
