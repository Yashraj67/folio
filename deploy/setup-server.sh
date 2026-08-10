#!/usr/bin/env bash
# One-shot Folio server setup for a fresh Ubuntu VM (tested target: Oracle
# Cloud Always Free VM.Standard.A1.Flex, Ubuntu 22.04/24.04 aarch64).
# Run from the repo root: ./deploy/setup-server.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Ensuring swap exists (small shapes like E2.1.Micro need it)"
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 3000 ] && ! swapon --show | grep -q .; then
  sudo fallocate -l 3G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "    added 3G swapfile"
fi

echo "==> Installing Docker (if missing)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi

echo "==> Opening ports 80/443 in the OS firewall"
# Oracle's Ubuntu images ship a restrictive iptables INPUT chain; the cloud
# Security List must allow these ports too (done in the web console).
for port in 80 443; do
  if ! sudo iptables -C INPUT -m state --state NEW -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
  fi
done
sudo netfilter-persistent save 2>/dev/null || true

if [ ! -f .env ]; then
  echo "==> Creating .env"
  read -rp "Public domain (e.g. yourname.duckdns.org): " domain
  db_password=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
  cat > .env <<EOF
FOLIO_DOMAIN=${domain}
FOLIO_DB_PASSWORD=${db_password}
FOLIO_COOKIE_SECURE=1
FOLIO_REGISTRATION_OPEN=1
EOF
  echo "    wrote .env (generated a random DB password)"
else
  echo "==> Using existing .env"
fi

echo "==> Building and starting Folio (app + Postgres + Caddy HTTPS)"
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

echo
echo "Done. Folio will be live at https://$(grep FOLIO_DOMAIN .env | cut -d= -f2)"
echo "once DNS points at this VM (first HTTPS certificate takes ~30s)."
echo "Logs:   sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f"
echo "Update: git pull && sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d"
