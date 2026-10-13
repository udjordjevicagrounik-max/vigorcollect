#!/usr/bin/env bash
# Installs the system tools the git hooks and scripts need: gitleaks, semgrep, psql 16, age,
# then ensures the golden-test database exists (scripts/setup-test-db.sh).
# Idempotent: installs only what is missing. Run at the start of EVERY session — the dev
# container is ephemeral and tools installed outside the repo can disappear.
# Debian/Ubuntu, x86_64/arm64, run as root.
set -euo pipefail

BIN_DIR=/usr/local/bin
log() { printf '[setup-tools] %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || { echo "run as root" >&2; exit 1; }

case "$(uname -m)" in
  x86_64) GL_ARCH=x64 ;;
  aarch64 | arm64) GL_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

APT_UPDATED=0
apt_install() {
  if [[ "$APT_UPDATED" -eq 0 ]]; then apt-get update -qq; APT_UPDATED=1; fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
}

need_base=()
for cmd in curl gpg; do command -v "$cmd" >/dev/null || need_base+=("$cmd"); done
if ((${#need_base[@]})); then
  log "installing base packages: ${need_base[*]}"
  apt_install curl ca-certificates gnupg
fi

# --- psql 16 (PGDG; distro repos ship an older client) ---------------------------------------
if command -v psql >/dev/null && psql --version | grep -qE ' 1[6-9]\.'; then
  log "psql ok: $(psql --version)"
else
  log "installing postgresql-client-16 from PGDG"
  . /etc/os-release
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    >/etc/apt/sources.list.d/pgdg.list
  APT_UPDATED=0
  apt_install postgresql-client-16
  log "psql installed: $(psql --version)"
fi

# --- age (backup encryption, review S-11) — the same Debian package as the worker image ------
if command -v age >/dev/null; then
  log "age ok: $(age --version)"
else
  log "installing age"
  apt_install age
  log "age installed: $(age --version)"
fi

# --- semgrep (pipx) + symlink so git hooks find it without the interactive PATH ----------------
# The dev container exports PIP_TARGET/PYTHONPATH for its own Python deps; they hijack pipx's
# venv install ("cannot find package metadata"), so pipx runs with a clean pip environment.
SEMGREP_PIPX="${PIPX_BIN_DIR:-$HOME/.local/bin}/semgrep"
if ! env -u PYTHONPATH "$SEMGREP_PIPX" --version >/dev/null 2>&1; then
  command -v pipx >/dev/null || { log "installing pipx"; apt_install pipx; }
  log "installing semgrep via pipx"
  env -u PIP_TARGET -u PYTHONPATH -u PIP_BREAK_SYSTEM_PACKAGES PIP_CONFIG_FILE=/dev/null \
    pipx install --force semgrep >/dev/null
fi
ln -sf "$SEMGREP_PIPX" "$BIN_DIR/semgrep"
log "semgrep ok: $(env -u PYTHONPATH "$BIN_DIR/semgrep" --version 2>/dev/null)"

# --- gitleaks (latest stable release) ---------------------------------------------------------
if command -v gitleaks >/dev/null; then
  log "gitleaks ok: $(gitleaks version)"
else
  GL_VER="$(curl -fsSL https://api.github.com/repos/gitleaks/gitleaks/releases/latest |
    grep -Po '"tag_name":\s*"v\K[^"]+')"
  [[ -n "$GL_VER" ]] || { echo "could not resolve latest gitleaks version" >&2; exit 1; }
  log "installing gitleaks $GL_VER"
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GL_VER}/gitleaks_${GL_VER}_linux_${GL_ARCH}.tar.gz" |
    tar -xz -C "$BIN_DIR" gitleaks
  chmod 0755 "$BIN_DIR/gitleaks"
  log "gitleaks installed: $(gitleaks version)"
fi

log "all tools present."

# --- golden-test database (collect_test) --------------------------------------------------------
"$(dirname "${BASH_SOURCE[0]}")/setup-test-db.sh"
