#!/bin/sh
set -eu
binary=$1
shift
exec docker run --rm --network host -e PGPASSWORD -v "$(pwd):$(pwd)" -w "$(pwd)" postgres:18-bookworm "$binary" "$@"
