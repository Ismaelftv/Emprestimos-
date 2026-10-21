#!/usr/bin/env bash
# Backup do banco + arquivos. Rode diariamente (cron):  0 3 * * * /caminho/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT="${BACKUP_DIR:-$HOME/caixa-backups}"; STAMP=$(date +%Y%m%d-%H%M%S); mkdir -p "$OUT"
docker compose exec -T db pg_dump -U caixa -Fc caixa > "$OUT/db-$STAMP.dump"
docker run --rm -v deploy_files:/data -v "$OUT":/out alpine tar czf "/out/files-$STAMP.tgz" -C /data .
find "$OUT" -type f -mtime +30 -delete   # guarda 30 dias
echo "Backup em $OUT ($STAMP). Copie também para FORA do servidor e guarde a FILE_KEY separada."
# Restaurar:  docker compose exec -T db pg_restore -U caixa -d caixa --clean < db-XXXX.dump
