FROM postgres:18-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends age && rm -rf /var/lib/apt/lists/*
COPY ops/backup.sh /usr/local/bin/poste-backup
RUN chmod +x /usr/local/bin/poste-backup
ENTRYPOINT ["/usr/local/bin/poste-backup"]
