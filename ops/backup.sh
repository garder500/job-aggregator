#!/bin/sh
set -eu
umask 077
: "${BACKUP_AGE_RECIPIENT:?Configure an age public recipient}"
while true; do
  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"' EXIT INT TERM
  pg_dump -Fc > "$temporary/database.dump"
  tar -C / -cf "$temporary/archive.tar" data sessions -C "$temporary" database.dump
  age -r "$BACKUP_AGE_RECIPIENT" -o "/backups/poste-$(date -u +%Y%m%dT%H%M%SZ).tar.age" "$temporary/archive.tar"
  rm -rf "$temporary"
  trap - EXIT INT TERM
  if [ "${BACKUP_ONCE:-0}" = 1 ]; then exit 0; fi
  sleep 86400
done
